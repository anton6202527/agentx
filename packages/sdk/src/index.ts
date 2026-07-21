/**
 * @anicode/sdk —— AniCode server 的类型化客户端（对齐 opencode 的 SDK 形态）。
 *
 * 与 server 的契约以 core 的 `daemon/api.ts`（ROUTES/EVENTS/信封）为单一事实源；
 * 本包只做 type-only 导入（运行时零依赖，仅用全局 fetch），便于将来独立发布。
 *
 * 用法：
 *   const client = createAnicodeClient({ baseUrl: "http://127.0.0.1:8317" });
 *   const s = await client.session.create({ cwd, model });
 *   for await (const ev of client.event.subscribe(s.id, { signal })) { ... }
 */

import type {
  Checkpoint,
  EventEnvelope,
  MessageWithParts,
  PermissionAnswer,
  PermissionMode,
  PermissionProfile,
  RewindMode,
  SessionSnapshot,
  SessionSummary,
} from "@anicode/core";

export type {
  Checkpoint,
  EventEnvelope,
  MessageWithParts,
  PermissionAnswer,
  PermissionMode,
  PermissionProfile,
  RewindMode,
  SessionSnapshot,
  SessionSummary,
};

export interface AnicodeClientOptions {
  /** 形如 http://127.0.0.1:8317（不带尾斜杠）。 */
  baseUrl: string;
  /** server 配置的 Bearer token（SSE 自动转查询参数）。 */
  token?: string;
  /** 自定义 fetch（测试注入）。缺省用全局 fetch。 */
  fetch?: typeof fetch;
}

/** 非 2xx 响应抛出：带状态码与 server 返回的 error 文本。 */
export class AnicodeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AnicodeApiError";
  }
}

export interface SubscribeOptions {
  signal?: AbortSignal;
}

export interface AnicodeClient {
  global: {
    health(): Promise<{ ok: boolean; name: string; protocol: number }>;
    /** OpenAPI 3.1 文档（GET /doc）。 */
    doc(): Promise<Record<string, unknown>>;
  };
  session: {
    list(): Promise<SessionSummary[]>;
    create(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary>;
    get(id: string): Promise<SessionSnapshot>;
    delete(id: string): Promise<void>;
    setTitle(id: string, title: string): Promise<void>;
    /** Message+Parts 投影（GET /sessions/:id/messages）。 */
    messages(id: string): Promise<MessageWithParts[]>;
    checkpoints(id: string): Promise<Checkpoint[]>;
    /** 发消息驱动 agent loop；resolve 于本次 drive 收尾。 */
    send(id: string, text: string, opts?: { model?: string }): Promise<void>;
    interrupt(id: string): Promise<void>;
    undo(
      id: string,
      opts?: { checkpointId?: string; mode?: RewindMode },
    ): Promise<{ restored: number; deleted: number; removedMessages?: number }>;
    compact(id: string): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
    fork(id: string, opts?: { title?: string; upToMessage?: number }): Promise<SessionSummary>;
  };
  permission: {
    reply(sessionId: string, permId: string, decision: PermissionAnswer): Promise<boolean>;
    setMode(sessionId: string, mode: PermissionMode): Promise<void>;
    setProfile(sessionId: string, name: string): Promise<PermissionMode>;
    listProfiles(sessionId: string): Promise<Record<string, PermissionProfile>>;
  };
  event: {
    /**
     * 订阅会话事件流（SSE 信封）。首帧保证 server.connected，随后 session.snapshot，
     * 之后实时事件。流断开即结束（不自动重连），signal 可主动取消。
     */
    subscribe(sessionId: string, opts?: SubscribeOptions): AsyncGenerator<EventEnvelope>;
  };
}

/** 增量解析 SSE：按空行分帧，拼接 data 行；忽略注释与 event/id 字段。 */
function splitSse(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
  }
  return { payloads, rest };
}

export function createAnicodeClient(opts: AnicodeClientOptions): AnicodeClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...extra,
  });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headers(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* 保持状态码信息 */
      }
      throw new AnicodeApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const sid = (id: string) => encodeURIComponent(id);

  async function* subscribe(
    sessionId: string,
    subOpts: SubscribeOptions = {},
  ): AsyncGenerator<EventEnvelope> {
    const url = new URL(`${baseUrl}/sessions/${sid(sessionId)}/events`);
    if (opts.token) url.searchParams.set("token", opts.token);
    const res = await doFetch(url, {
      headers: headers(),
      ...(subOpts.signal ? { signal: subOpts.signal } : {}),
    });
    if (!res.ok || !res.body)
      throw new AnicodeApiError(res.status, `SSE subscribe failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { payloads, rest } = splitSse(buffer);
        buffer = rest;
        for (const payload of payloads) yield JSON.parse(payload) as EventEnvelope;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return {
    global: {
      health: () => call("GET", "/global/health"),
      doc: () => call("GET", "/doc"),
    },
    session: {
      list: () => call("GET", "/sessions"),
      create: (input) => call("POST", "/sessions", input),
      get: (id) => call("GET", `/sessions/${sid(id)}`),
      delete: (id) => call("DELETE", `/sessions/${sid(id)}`),
      setTitle: (id, title) => call("PATCH", `/sessions/${sid(id)}`, { title }),
      messages: (id) => call("GET", `/sessions/${sid(id)}/messages`),
      checkpoints: (id) => call("GET", `/sessions/${sid(id)}/checkpoints`),
      send: (id, text, sendOpts) =>
        call("POST", `/sessions/${sid(id)}/send`, {
          text,
          ...(sendOpts?.model ? { model: sendOpts.model } : {}),
        }),
      interrupt: (id) => call("POST", `/sessions/${sid(id)}/interrupt`, {}),
      undo: (id, undoOpts) =>
        call("POST", `/sessions/${sid(id)}/undo`, {
          ...(undoOpts?.checkpointId ? { checkpointId: undoOpts.checkpointId } : {}),
          ...(undoOpts?.mode ? { mode: undoOpts.mode } : {}),
        }),
      compact: (id) => call("POST", `/sessions/${sid(id)}/compact`, {}),
      fork: (id, forkOpts) =>
        call("POST", `/sessions/${sid(id)}/fork`, {
          ...(forkOpts?.title !== undefined ? { title: forkOpts.title } : {}),
          ...(forkOpts?.upToMessage !== undefined ? { upToMessage: forkOpts.upToMessage } : {}),
        }),
    },
    permission: {
      reply: async (sessionId, permId, decision) => {
        const r = await call<{ answered: boolean }>(
          "POST",
          `/sessions/${sid(sessionId)}/permission`,
          { permId, decision },
        );
        return r.answered;
      },
      setMode: (sessionId, mode) =>
        call("POST", `/sessions/${sid(sessionId)}/permission-mode`, { mode }),
      setProfile: async (sessionId, name) => {
        const r = await call<{ mode: PermissionMode }>(
          "POST",
          `/sessions/${sid(sessionId)}/permission-profile`,
          { name },
        );
        return r.mode;
      },
      listProfiles: (sessionId) => call("GET", `/sessions/${sid(sessionId)}/permission-profiles`),
    },
    event: { subscribe },
  };
}
