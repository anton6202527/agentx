/**
 * 会话持久化 —— 把 Agent 的对话历史落盘，支持列出与 resume。
 *
 * 存储格式：每个会话一个 JSONL 文件。
 *   第 1 行：meta（id / 创建时间 / cwd / model / title）
 *   后续每行：一条 ChatMessage
 * 选 JSONL 而非单个 JSON，是为了能「追加写」——每轮结束 append 新消息，
 * 不必重写整个文件，长会话也不卡。
 *
 * 默认目录：~/.agentx/sessions/（可覆盖）。core 不碰凭证，只存对话。
 */

import { promises as fs, createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ChatMessage } from "./types.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  title?: string;
}

export interface SessionData extends SessionMeta {
  messages: ChatMessage[];
}

function defaultDir(): string {
  return path.join(os.homedir(), ".agentx", "sessions");
}

/** 生成一个可排序（时间前缀）的会话 id，无外部依赖 */
export function newSessionId(now: number, rand: () => number): string {
  const ts = now.toString(36).padStart(9, "0");
  const suffix = Math.floor(rand() * 0xfffff).toString(36).padStart(4, "0");
  return `s_${ts}_${suffix}`;
}

export class SessionStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultDir();
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  /** 创建新会话文件，写入 meta 头行 */
  async create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    await fs.mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    await fs.writeFile(this.file(meta.id), JSON.stringify({ __meta: full }) + "\n", "utf8");
    return full;
  }

  /** 追加一条消息（每轮结束调用） */
  async append(id: string, message: ChatMessage): Promise<void> {
    await fs.appendFile(this.file(id), JSON.stringify(message) + "\n", "utf8");
  }

  /**
   * 一次性覆盖写入全部消息（compaction 改写历史后用）。
   * 原子写：先写 .tmp 再 rename —— 中途崩溃只会留下 tmp 残片，
   * 原会话文件要么是旧的完整版本、要么是新的完整版本，绝不会半截。
   */
  async rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const updated: SessionMeta = { ...meta, updatedAt: new Date().toISOString() };
    const lines = [JSON.stringify({ __meta: updated }), ...messages.map((m) => JSON.stringify(m))];
    const target = this.file(meta.id);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, lines.join("\n") + "\n", "utf8");
    await fs.rename(tmp, target);
  }

  /** 读取整个会话（流式逐行解析，避免大文件一次性读入） */
  async load(id: string): Promise<SessionData> {
    const rl = readline.createInterface({
      input: createReadStream(this.file(id), "utf8"),
      crlfDelay: Infinity,
    });
    let meta: SessionMeta | null = null;
    const messages: ChatMessage[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.__meta) meta = obj.__meta;
      else messages.push(obj as ChatMessage);
    }
    if (!meta) throw new Error(`会话 ${id} 缺少 meta 头`);
    return { ...meta, messages };
  }

  /** 列出所有会话的 meta（按 updatedAt 倒序），不加载消息 */
  async list(): Promise<SessionMeta[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const first = await readFirstLine(path.join(this.dir, f));
        const obj = JSON.parse(first);
        if (obj.__meta) metas.push(obj.__meta);
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }
}

async function readFirstLine(file: string): Promise<string> {
  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}
