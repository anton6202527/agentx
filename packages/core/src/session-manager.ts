/**
 * SessionManager —— 带 pub/sub 的会话总线。core 的多路复用层。
 *
 * 解决旧 daemon 的根本缺陷：事件曾只流向发起 send 的那个连接。这里每个会话是
 * 一个广播源，任意数量的订阅者都能实时收到同一批事件 —— 这才让「CLI 与 App
 * 共享同一会话、互相接管」成立。
 *
 * 职责：
 *   - 持有 live 会话（Agent 实例），按需 create / resume
 *   - send 时驱动 Agent，把每个事件广播给所有订阅者
 *   - 权限请求作为会话事件广播；answerPermission 由任一订阅者裁决（先到先得）
 *   - subscribe 立即回放一份 snapshot（transcript + running），供晚加入者对齐
 *
 * 传输无关：进程内前端直接用它；daemon 只是它之上的一层 socket 转发。
 */

import type { ChatMessage, Provider, Usage } from "./types.js";
import { Agent, type AgentEvent } from "./agent.js";
import type { ToolRegistry } from "./tools/tool.js";
import type { CompactionConfig } from "./context.js";
import { SessionStore, newSessionId, type SessionMeta } from "./session.js";
import type { PermissionDecision, PermissionRequest } from "./permission.js";

// ---------- 对外事件与快照 ----------

/** 会话级事件：包裹 AgentEvent，另加权限询问与运行态变化 */
export type SessionEvent =
  | { type: "agent"; event: AgentEvent }
  | { type: "permission_request"; permId: string; toolName: string; ruleKey: string }
  | { type: "state"; running: boolean };

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: ChatMessage[];
  usage: Usage;
  running: boolean;
  /** 订阅时仍待裁决的权限请求（重连场景不至于卡死） */
  pendingPermissions: { permId: string; toolName: string; ruleKey: string }[];
}

export interface SessionSummary extends SessionMeta {
  running: boolean;
}

export type SessionListener = (ev: SessionEvent) => void;

export interface SessionManagerOptions {
  /** 按 model 字符串产出 provider 实例（通常包 createProvider） */
  resolveProvider: (model: string) => { provider: Provider; model: string };
  store: SessionStore;
  /** 传入即为所有会话启用工具集（默认 Agent 内置默认工具） */
  tools?: () => ToolRegistry;
  /** 每会话默认开启压缩 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 生成会话 id 的时钟/随机源（测试可注入） */
  now?: () => number;
  rand?: () => number;
}

interface PendingPerm {
  toolName: string;
  ruleKey: string;
  resolve: (d: PermissionDecision) => void;
}

// ---------- 一个受管会话 ----------

class ManagedSession {
  readonly meta: SessionMeta;
  private agent: Agent;
  private listeners = new Set<SessionListener>();
  private pending = new Map<string, PendingPerm>();
  private abort: AbortController | null = null;
  private permSeq = 0;

  constructor(
    meta: SessionMeta,
    makeAgent: (confirm: (r: PermissionRequest) => Promise<PermissionDecision>) => Agent,
  ) {
    this.meta = meta;
    this.agent = makeAgent((r) => this.onConfirm(r));
  }

  get running(): boolean {
    return this.agent.isRunning;
  }

  snapshot(): SessionSnapshot {
    const s = this.agent.snapshot();
    return {
      meta: this.meta,
      messages: s.messages,
      usage: s.usage,
      running: this.running,
      pendingPermissions: [...this.pending.entries()].map(([permId, p]) => ({
        permId,
        toolName: p.toolName,
        ruleKey: p.ruleKey,
      })),
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  /** Agent 请求授权 → 广播 permission_request，挂起直到 answer */
  private onConfirm(r: PermissionRequest): Promise<PermissionDecision> {
    const permId = r.toolCallId || `perm_${++this.permSeq}`;
    return new Promise((resolve) => {
      this.pending.set(permId, { toolName: r.toolName, ruleKey: r.ruleKey, resolve });
      this.emit({ type: "permission_request", permId, toolName: r.toolName, ruleKey: r.ruleKey });
    });
  }

  answerPermission(permId: string, decision: "allow" | "allow_remember" | "deny"): boolean {
    const p = this.pending.get(permId);
    if (!p) return false;
    this.pending.delete(permId);
    p.resolve(
      decision === "deny"
        ? { behavior: "deny", message: "已拒绝该操作" }
        : { behavior: "allow", remember: decision === "allow_remember" },
    );
    return true;
  }

  /** 驱动一次 loop，广播事件给所有订阅者 */
  async send(text: string): Promise<void> {
    if (this.running) throw new Error("会话正忙");
    this.abort = new AbortController();
    this.emit({ type: "state", running: true });
    try {
      for await (const ev of this.agent.send(text, this.abort.signal)) {
        this.emit({ type: "agent", event: ev });
      }
    } finally {
      this.abort = null;
      // 会话结束时，未答复的权限请求视为拒绝，避免悬挂
      for (const [permId] of this.pending) this.answerPermission(permId, "deny");
      this.emit({ type: "state", running: false });
    }
  }

  interrupt(): void {
    this.abort?.abort();
    // 中断时，把待决权限拒掉让 loop 尽快收束
    for (const [permId] of this.pending) this.answerPermission(permId, "deny");
  }
}

// ---------- 管理器 ----------

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const metas = await this.opts.store.list();
    return metas.map((m) => ({ ...m, running: this.sessions.get(m.id)?.running ?? false }));
  }

  async createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    const id = newSessionId((this.opts.now ?? Date.now)(), this.opts.rand ?? Math.random);
    const meta = await this.opts.store.create({
      id,
      cwd: input.cwd,
      model: input.model,
      ...(input.title ? { title: input.title } : {}),
    });
    this.instantiate(meta, []);
    return { ...meta, running: false };
  }

  /** resume：从磁盘载入历史，实例化 live 会话（若已在内存则复用） */
  async resumeSession(sessionId: string): Promise<SessionSnapshot> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.snapshot();
    const data = await this.opts.store.load(sessionId);
    const meta: SessionMeta = {
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      cwd: data.cwd,
      model: data.model,
      ...(data.title ? { title: data.title } : {}),
    };
    const session = this.instantiate(meta, data.messages);
    return session.snapshot();
  }

  /** 订阅：立即回放 snapshot，之后实时收事件。返回 unsubscribe。 */
  async open(
    sessionId: string,
    listener: SessionListener,
  ): Promise<{ snapshot: SessionSnapshot; close: () => void }> {
    const session = await this.ensureLive(sessionId);
    const close = session.subscribe(listener);
    return { snapshot: session.snapshot(), close };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const session = await this.ensureLive(sessionId);
    await session.send(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.interrupt();
  }

  async answerPermission(
    sessionId: string,
    permId: string,
    decision: "allow" | "allow_remember" | "deny",
  ): Promise<boolean> {
    return this.sessions.get(sessionId)?.answerPermission(permId, decision) ?? false;
  }

  // ---------- 内部 ----------

  private async ensureLive(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    // 内存里没有 → 从磁盘 resume
    await this.resumeSession(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
  }

  private instantiate(meta: SessionMeta, resumeMessages: ChatMessage[]): ManagedSession {
    const resolved = this.opts.resolveProvider(meta.model);
    const session = new ManagedSession(meta, (confirm) =>
      new Agent({
        provider: resolved.provider,
        model: resolved.model,
        cwd: meta.cwd,
        permission: { mode: "default", confirm },
        ...(this.opts.tools ? { tools: this.opts.tools() } : {}),
        ...(this.opts.compaction !== undefined ? { compaction: this.opts.compaction } : {}),
        persistence: {
          store: this.opts.store,
          meta,
          ...(resumeMessages.length ? { resumeMessages } : {}),
        },
      }),
    );
    this.sessions.set(meta.id, session);
    return session;
  }
}
