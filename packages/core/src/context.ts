/**
 * 上下文管理 —— 两件事：
 *
 * 1. 项目记忆（AGENTS.md / CLAUDE.md）：从 cwd 向上逐级查找并拼进 system 提示，
 *    让 agent 知道项目约定。业界已趋同于 AGENTS.md。
 *
 * 2. Compaction：历史增长到接近上下文上限时，把较旧的若干轮压缩成一段摘要，
 *    换回若干 token 空间，同时保留最近若干轮原文。摘要动作用一个「summarizer」
 *    函数完成（可注入 —— 生产用小模型，测试用假实现），因此本模块可离线测试。
 *
 * token 估算用字符数近似（1 token ≈ 4 char），够 compaction 触发判断用；
 * 精确计费仍以 provider 返回的 usage 为准。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChatMessage, ContentPart } from "./types.js";

// ---------- 项目记忆 ----------

const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md"];

/** 从 cwd 向上（到文件系统根或 .git 边界）收集所有记忆文件，就近优先拼接 */
export async function loadProjectMemory(cwd: string): Promise<string> {
  const chunks: string[] = [];
  let dir = path.resolve(cwd);
  const seenGitRoot = { hit: false };

  while (true) {
    for (const name of MEMORY_FILES) {
      const file = path.join(dir, name);
      try {
        const text = await fs.readFile(file, "utf8");
        chunks.push(`# 项目记忆（${path.relative(cwd, file) || name}）\n${text.trim()}`);
      } catch {
        /* 文件不存在，跳过 */
      }
    }
    // 到 .git 所在目录就停（项目边界）
    try {
      await fs.access(path.join(dir, ".git"));
      seenGitRoot.hit = true;
    } catch {
      /* no .git here */
    }
    const parent = path.dirname(dir);
    if (parent === dir || seenGitRoot.hit) break;
    dir = parent;
  }
  return chunks.join("\n\n");
}

/** 把项目记忆拼到基础 system 提示后面 */
export function composeSystem(base: string, projectMemory: string): string {
  if (!projectMemory) return base;
  return `${base}\n\n${projectMemory}`;
}

// ---------- token 估算 ----------

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const part of m.content) chars += partChars(part);
  }
  return Math.ceil(chars / 4);
}

function partChars(part: ContentPart): number {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.text.length;
    case "tool_call":
      return part.name.length + JSON.stringify(part.args).length;
    case "tool_result":
      return part.content.length;
    case "image":
      return 1000; // 图片按固定近似
  }
}

// ---------- Compaction ----------

export type Summarizer = (messages: ChatMessage[]) => Promise<string>;

export interface CompactionConfig {
  /** 触发阈值（token 估算）。默认 120k（给 1M 窗口留足余量 + 控成本） */
  triggerTokens?: number;
  /** 压缩后保留的最近轮数（一轮 = 一个 user + 后续 assistant/tool 往返） */
  keepRecentMessages?: number;
  summarizer: Summarizer;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/** 纯文本 user 消息（不含 tool_result）—— 唯一安全的压缩切割点 */
function isPlainUserText(m: ChatMessage): boolean {
  return m.role === "user" && !m.content.some((p) => p.type === "tool_result");
}

/**
 * 找一个安全的切割点：保留窗口必须始于纯文本 user 消息。
 * 若从 cutoff 处切会把 tool_use/tool_result 对切断（保留窗口以 tool_result 开头，
 * 其对应的 tool_use 已被摘要吞掉），provider 回放会直接 400。
 * 策略：从期望 cutoff 向后（更晚）找最近的安全边界；找不到再向前找；都没有则放弃压缩。
 */
function findSafeCutoff(history: ChatMessage[], desired: number): number | null {
  for (let i = desired; i < history.length; i++) {
    if (isPlainUserText(history[i]!)) return i;
  }
  for (let i = desired - 1; i > 0; i--) {
    if (isPlainUserText(history[i]!)) return i;
  }
  return null;
}

/**
 * 若 history 估算超阈值，则：
 *   [旧消息] → summarizer 摘要成一条 assistant「上下文摘要」消息，
 *   接上最近若干条原文（从安全边界起，见 findSafeCutoff）。
 * 否则原样返回。
 *
 * 保证：
 *   - 第一条一定是 user（摘要包成 user→assistant 对，满足角色交替）
 *   - 保留窗口始于纯文本 user 消息，绝不切断 tool_use/tool_result 对
 */
export async function maybeCompact(
  history: ChatMessage[],
  cfg: CompactionConfig,
): Promise<CompactionResult> {
  const trigger = cfg.triggerTokens ?? 120_000;
  const keep = cfg.keepRecentMessages ?? 6;
  const before = estimateTokens(history);

  if (before < trigger || history.length <= keep + 2) {
    return { messages: history, compacted: false, beforeTokens: before, afterTokens: before };
  }

  const cutoff = findSafeCutoff(history, history.length - keep);
  if (cutoff === null || cutoff === 0) {
    // 没有安全切割点（如整段都是一个超长工具往返），放弃本次压缩
    return { messages: history, compacted: false, beforeTokens: before, afterTokens: before };
  }
  const older = history.slice(0, cutoff);
  const recent = history.slice(cutoff);

  const summary = await cfg.summarizer(older);
  const compactedPair: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "[此前对话已压缩，以下是摘要，请据此继续]" }] },
    { role: "assistant", content: [{ type: "text", text: summary }] },
  ];

  // 确保 recent 从 user 开始；若不是，前面的 assistant 摘要对已经保证了交替
  const messages = [...compactedPair, ...recent];
  const after = estimateTokens(messages);
  return { messages, compacted: true, beforeTokens: before, afterTokens: after };
}

/** 基于 provider 的默认 summarizer 工厂（生产用）。测试可注入假实现。 */
export function providerSummarizer(
  stream: (messages: ChatMessage[], system: string) => AsyncIterable<{ type: string; text?: string }>,
): Summarizer {
  return async (messages) => {
    const system =
      "你是上下文压缩器。把下面的对话历史压缩成简洁但信息完整的摘要：保留已做的关键决定、" +
      "改动过的文件、未完成的任务、重要事实。用要点列表，不要寒暄。";
    const flattened: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: renderHistory(messages) }],
    };
    let out = "";
    for await (const ev of stream([flattened], system)) {
      if (ev.type === "text" && ev.text) out += ev.text;
    }
    return out.trim() || "（摘要为空）";
  };
}

function renderHistory(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text") lines.push(`${m.role}: ${part.text}`);
      else if (part.type === "tool_call") lines.push(`${m.role} 调用工具 ${part.name}(${JSON.stringify(part.args)})`);
      else if (part.type === "tool_result") lines.push(`工具结果: ${part.content.slice(0, 500)}`);
    }
  }
  return lines.join("\n");
}
