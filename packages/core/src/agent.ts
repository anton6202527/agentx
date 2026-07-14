/**
 * Agent —— core 的中枢。把 provider（模型）+ tools（能力）+ permission（护栏）
 * 编织成一个 agent loop，对外只暴露「发消息 → 消费事件流」两个动作，UI 无关。
 *
 * loop：模型流式输出 → 若请求工具则逐个过权限门并执行 → 结果回传 → 继续，
 * 直到模型不再调用工具或达到 maxTurns。
 *
 * Agent 只负责「一个会话的一次驱动」。多订阅者广播、跨连接接管由上层
 * SessionManager 负责 —— Agent 保持单一职责，可独立测试。
 */

import type { ChatMessage, Provider, StreamEvent, ToolResultPart, Usage } from "./types.js";
import { emptyUsage, textMessage, toolCallsOf } from "./types.js";
import { PermissionEngine, type PermissionConfig } from "./permission.js";
import { ToolRegistry, ToolError, type Tool } from "./tools/tool.js";
import { defaultTools } from "./tools/index.js";
import {
  loadProjectMemory,
  composeSystem,
  maybeCompact,
  providerSummarizer,
  type CompactionConfig,
} from "./context.js";
import type { SessionStore, SessionMeta } from "./session.js";

// ---------- 对外事件 ----------

export type AgentEvent =
  | { type: "text"; text: string } // 流式文本增量
  | { type: "thinking"; text: string } // 流式推理增量
  | { type: "tool_start"; id: string; name: string; ruleKey: string }
  | { type: "tool_permission"; id: string; name: string; decision: "allow" | "deny" }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "turn_end"; usage: Usage } // 一个模型轮结束（可能还要继续 loop）
  | { type: "compacted"; beforeTokens: number; afterTokens: number } // 上下文被压缩
  | { type: "done"; usage: Usage; turns: number } // 整个 loop 结束，等待下一条用户输入
  | { type: "error"; message: string };

export interface AgentOptions {
  provider: Provider;
  model: string;
  cwd: string;
  system?: string;
  tools?: ToolRegistry;
  permission?: PermissionConfig;
  maxTurns?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 是否加载 AGENTS.md/CLAUDE.md 项目记忆（默认开） */
  projectMemory?: boolean;
  /** 上下文压缩配置。传入即启用；summarizer 缺省用当前 provider 自摘要 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话持久化 */
  persistence?: PersistenceConfig;
}

export interface PersistenceConfig {
  store: SessionStore;
  /** 会话 meta（含 id）。resume 时传已有会话的 meta。 */
  meta: SessionMeta;
  /** resume：预填历史（跳过再次写 meta，只在此后 append） */
  resumeMessages?: ChatMessage[];
}

/** Agent 的可序列化状态快照 —— 供晚加入的订阅者 / resume 渲染重建界面 */
export interface AgentSnapshot {
  messages: ChatMessage[];
  usage: Usage;
}

/**
 * 历史自愈：若历史以「含 tool_call 但缺配对 tool_result 的 assistant 消息」结尾
 * （进程崩溃 / 强杀留下的悬空状态），补上合成错误结果 —— 否则下一次
 * provider 回放必 400（tool_use 无配对 tool_result）。
 * 返回新数组；无需修复时原样返回（引用相等，调用方可据此判断是否发生了修复）。
 */
export function repairHistory(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const calls = toolCallsOf(last);
  if (calls.length === 0) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: calls.map((c) => ({
        type: "tool_result" as const,
        toolCallId: c.id,
        toolName: c.name,
        content: "（会话在该工具执行完成前中断，结果不可用）",
        isError: true,
      })),
    },
  ];
}

const DEFAULT_SYSTEM = `你是一个运行在用户终端里的 AI 编程助手。你可以读写文件、执行 shell 命令来完成编码任务。
- 动手前先了解相关代码；修改要精确、最小化。
- 有副作用的操作（写文件、执行命令）会经过用户授权，被拒绝时请换一种方式或询问用户。
- 完成后用一两句话说明你做了什么。`;

export class Agent {
  private readonly provider: Provider;
  private readonly model: string;
  private readonly cwd: string;
  private readonly baseSystem: string;
  private readonly tools: ToolRegistry;
  private readonly perm: PermissionEngine;
  private readonly maxTurns: number;
  private readonly maxTokens: number;
  private readonly effort: AgentOptions["effort"];
  private readonly useProjectMemory: boolean;
  private readonly compaction: CompactionConfig | null;
  private readonly persist: PersistenceConfig | null;

  private system: string;
  private memoryLoaded = false;
  private history: ChatMessage[] = [];
  private cumulative: Usage = emptyUsage();
  private persistedCount = 0; // 已 append 进会话文件的消息数；compaction 后重置
  private running = false; // 并发护栏：send 不可重入

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.baseSystem = opts.system ?? DEFAULT_SYSTEM;
    this.system = this.baseSystem;
    this.tools = opts.tools ?? defaultTools();
    this.maxTurns = opts.maxTurns ?? 50;
    this.maxTokens = opts.maxTokens ?? 16000;
    this.effort = opts.effort;
    this.useProjectMemory = opts.projectMemory ?? true;
    this.compaction = this.resolveCompaction(opts.compaction);
    this.persist = opts.persistence ?? null;
    if (this.persist?.resumeMessages) {
      const resumed = [...this.persist.resumeMessages];
      // 这些已在文件里，勿重复写；自愈补上的合成结果会在下次 flush 时落盘
      this.persistedCount = resumed.length;
      this.history = repairHistory(resumed);
    }
    // 只读工具名并入权限引擎，自动放行
    this.perm = new PermissionEngine({
      ...opts.permission,
      readOnlyTools: [...(opts.permission?.readOnlyTools ?? []), ...this.tools.readOnlyNames()],
    });
  }

  // ---------- 只读访问 ----------

  get isRunning(): boolean {
    return this.running;
  }
  get totalUsage(): Usage {
    return this.cumulative;
  }
  get messages(): readonly ChatMessage[] {
    return this.history;
  }
  snapshot(): AgentSnapshot {
    return { messages: [...this.history], usage: this.cumulative };
  }

  // ---------- 驱动 ----------

  /**
   * 发一条用户消息，驱动 loop，产出事件流直到本次 done。
   * 并发护栏：上一轮未结束时再次调用会抛错（由上层排队或拒绝）。
   */
  async *send(userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (this.running) throw new Error("会话正忙：上一轮尚未结束");
    this.running = true;
    try {
      yield* this.drive(userText, signal ?? new AbortController().signal);
    } finally {
      this.running = false;
    }
  }

  private async *drive(userText: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.ensureMemory();
    this.history.push(textMessage("user", userText));
    await this.flushPersist();

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // 压缩：每轮 provider 调用前检查历史规模
      if (this.compaction) {
        const res = await maybeCompact(this.history, this.compaction);
        if (res.compacted) {
          this.history = res.messages;
          await this.rewritePersist(); // 历史被改写，整文件重写
          yield { type: "compacted", beforeTokens: res.beforeTokens, afterTokens: res.afterTokens };
        }
      }

      const outcome = yield* this.runModelTurn(signal);
      if (outcome.type === "error") {
        yield { type: "error", message: outcome.message };
        return;
      }

      this.history.push(outcome.message);
      await this.flushPersist();
      this.accumulate(outcome.usage);
      yield { type: "turn_end", usage: outcome.usage };

      const calls = toolCallsOf(outcome.message);
      if (outcome.stopReason !== "tool_use" || calls.length === 0) {
        yield { type: "done", usage: this.cumulative, turns: turn };
        return;
      }

      const results: ToolResultPart[] = [];
      for (const call of calls) {
        yield* this.runTool(call, signal, results);
      }
      this.history.push({ role: "user", content: results });
      await this.flushPersist();
    }

    yield { type: "error", message: `达到最大轮数 ${this.maxTurns}，已停止` };
  }

  /** 跑一次模型补全，把流式增量转成 AgentEvent，聚合出最终消息 */
  private async *runModelTurn(
    signal: AbortSignal,
  ): AsyncGenerator<
    AgentEvent,
    | { type: "ok"; message: ChatMessage; stopReason: string; usage: Usage }
    | { type: "error"; message: string }
  > {
    let finalMessage: ChatMessage | null = null;
    let stopReason = "";
    let usage: Usage = emptyUsage();

    try {
      for await (const ev of this.provider.stream({
        model: this.model,
        system: this.system,
        messages: this.history,
        tools: this.tools.definitions(),
        maxTokens: this.maxTokens,
        ...(this.effort ? { effort: this.effort } : {}),
        signal,
      })) {
        if (ev.type === "text_delta") yield { type: "text", text: ev.text };
        else if (ev.type === "thinking_delta") yield { type: "thinking", text: ev.text };
        else if (ev.type === "done") {
          finalMessage = ev.message;
          stopReason = ev.stopReason;
          usage = ev.usage;
        }
      }
    } catch (err) {
      return { type: "error", message: errText(err) };
    }
    if (!finalMessage) return { type: "error", message: "provider 未产出 done 事件" };
    return { type: "ok", message: finalMessage, stopReason, usage };
  }

  /** 单个工具：权限门 → 执行 → 收集结果，并产出对应事件 */
  private async *runTool(
    call: { id: string; name: string; args: Record<string, unknown> },
    signal: AbortSignal,
    results: ToolResultPart[],
  ): AsyncGenerator<AgentEvent> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const msg = `未知工具: ${call.name}`;
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    const ruleKey = tool.ruleKey(call.args);
    yield { type: "tool_start", id: call.id, name: call.name, ruleKey };

    const decision = await this.perm.check({
      toolName: call.name,
      input: call.args,
      ruleKey,
      toolCallId: call.id,
      signal,
    });
    yield { type: "tool_permission", id: call.id, name: call.name, decision: decision.behavior };

    if (decision.behavior === "deny") {
      const msg = decision.message ?? "用户拒绝了该操作";
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    const input = decision.updatedInput ?? call.args;
    try {
      const content = await tool.run(input, { cwd: this.cwd, signal });
      results.push({ type: "tool_result", toolCallId: call.id, toolName: call.name, content });
      yield { type: "tool_result", id: call.id, name: call.name, content, isError: false };
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : errText(err);
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
    }
  }

  // ---------- 内部工具方法 ----------

  private resolveCompaction(cfg: AgentOptions["compaction"]): CompactionConfig | null {
    if (!cfg) return null;
    const defaultSummarizer = providerSummarizer((messages, system) =>
      this.streamText(messages, system),
    );
    if (cfg === true) return { summarizer: defaultSummarizer };
    return { summarizer: cfg.summarizer ?? defaultSummarizer, ...cfg };
  }

  /** 供默认 summarizer 用：以当前 provider 跑一次纯文本流 */
  private async *streamText(
    messages: ChatMessage[],
    system: string,
  ): AsyncIterable<{ type: string; text?: string }> {
    for await (const ev of this.provider.stream({
      model: this.model,
      system,
      messages,
      maxTokens: 2000,
    })) {
      if (ev.type === "text_delta") yield { type: "text", text: ev.text };
    }
  }

  private async ensureMemory(): Promise<void> {
    if (this.memoryLoaded || !this.useProjectMemory) return;
    this.memoryLoaded = true;
    const memory = await loadProjectMemory(this.cwd);
    if (memory) this.system = composeSystem(this.baseSystem, memory);
  }

  private async flushPersist(): Promise<void> {
    if (!this.persist) return;
    for (let i = this.persistedCount; i < this.history.length; i++) {
      await this.persist.store.append(this.persist.meta.id, this.history[i]!);
    }
    this.persistedCount = this.history.length;
  }

  private async rewritePersist(): Promise<void> {
    if (!this.persist) return;
    await this.persist.store.rewrite(this.persist.meta, this.history);
    this.persistedCount = this.history.length;
  }

  private accumulate(u: Usage): void {
    this.cumulative = {
      inputTokens: this.cumulative.inputTokens + u.inputTokens,
      outputTokens: this.cumulative.outputTokens + u.outputTokens,
      cacheReadTokens: this.cumulative.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: this.cumulative.cacheWriteTokens + u.cacheWriteTokens,
    };
  }
}

function errResult(id: string, name: string, msg: string): ToolResultPart {
  return { type: "tool_result", toolCallId: id, toolName: name, content: msg, isError: true };
}

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
}

export type { Tool };
