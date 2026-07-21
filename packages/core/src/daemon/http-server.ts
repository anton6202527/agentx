/**
 * HTTP + SSE 传输 —— server-first 路线（对齐 opencode）：SessionManager 之上的
 * 另一层薄转发，与 unix socket daemon 并存、可同时开。
 *
 * 端点以 `api.ts` 的 ROUTES 表为准（单一事实源），`GET /doc` 输出 OpenAPI 3.1。
 *
 * SSE 统一信封 `{ id, type, properties }`（见 api.ts EVENTS 目录）：
 *   首帧 server.connected → session.snapshot → 实时事件。其中：
 *   - `session.event` 原样透传 SessionEvent（host 客户端兼容通道）
 *   - `message.updated` / `message.part.updated` / `message.part.delta` 是
 *     Message+Parts 投影（每会话一个共享 PartsProjector，多个订阅端看到同一批
 *     part id），供 SDK/外部客户端做 UI 无关渲染
 *   - permission.asked/replied、session.status/updated/reverted 为命名细粒度事件
 *
 * 安全：默认只应绑定 127.0.0.1；可选 token —— 提供时所有请求须带
 * `Authorization: Bearer <token>`（SSE 亦可用 `?token=` 查询参数，便于 EventSource）。
 */

import * as http from "node:http";
import { t } from "../i18n.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";
import type { PermissionMode } from "../permission.js";
import { PartsProjector, messagesToParts } from "../parts.js";
import { createId } from "../id.js";
import { generateOpenApi, PROTOCOL_VERSION, type EventEnvelope } from "./api.js";

export interface HttpDaemonOptions {
  manager: SessionManager;
  /** 可选 Bearer token；提供时所有请求都要求携带。 */
  token?: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(t("request body too large", "请求体过大")));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function noContent(res: http.ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function envelope(type: string, properties: Record<string, unknown>): EventEnvelope {
  return { id: createId("evt"), type, properties };
}

/** SSE 帧：信封 JSON 单 data 行（JSON.stringify 无裸换行）。 */
function sseWrite(res: http.ServerResponse, ev: EventEnvelope): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/**
 * 每会话一份共享的事件扇出：单一 manager 订阅 + 单一 PartsProjector，
 * 广播给全部 SSE 连接（保证 part id 跨订阅端一致、投影恰好处理一次）。
 */
interface SessionFeed {
  close: () => void;
  writers: Set<(ev: EventEnvelope) => void>;
}

export class HttpDaemonServer {
  private server: http.Server;
  private manager: SessionManager;
  private token?: string;
  /** 活跃 SSE 连接的清理器，close 时逐个断开。 */
  private sseCleanups = new Set<() => void>();
  private feeds = new Map<string, SessionFeed>();

  constructor(opts: HttpDaemonOptions) {
    this.manager = opts.manager;
    if (opts.token) this.token = opts.token;
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        if (!res.headersSent)
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    });
  }

  /** 监听：默认只绑回环地址；绑 0.0.0.0 请务必配 token。 */
  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((res, rej) => {
      this.server.once("error", rej);
      this.server.listen(port, host, () => res());
    });
  }

  /** 实际监听端口（listen(0) 随机端口时用）。 */
  port(): number {
    const addr = this.server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  close(): Promise<void> {
    for (const cleanup of this.sseCleanups) cleanup();
    this.sseCleanups.clear();
    return new Promise((res) => this.server.close(() => res()));
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.token) return true;
    const header = req.headers.authorization;
    if (header === `Bearer ${this.token}`) return true;
    // EventSource 无法设 header，允许 SSE 用查询参数带 token。
    return url.searchParams.get("token") === this.token;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.authorized(req, url)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET") {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/global/health")
        return json(res, 200, { ok: true, name: "anicode", protocol: PROTOCOL_VERSION });
      if (url.pathname === "/doc") return json(res, 200, generateOpenApi());
      if (url.pathname === "/sessions") return json(res, 200, await this.manager.listSessions());
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        cwd?: string;
        model?: string;
        title?: string;
      };
      if (!body.cwd || !body.model) return json(res, 400, { error: "cwd and model are required" });
      const meta = await this.manager.createSession({
        cwd: body.cwd,
        model: body.model,
        ...(body.title ? { title: body.title } : {}),
      });
      return json(res, 200, meta);
    }

    // /sessions/:id —— 会话资源本体
    const mSelf = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (mSelf) {
      const sessionId = decodeURIComponent(mSelf[1]!);
      if (req.method === "GET") {
        const snap = await this.snapshotOf(sessionId);
        return snap ? json(res, 200, snap) : json(res, 404, { error: "not found" });
      }
      if (req.method === "DELETE") {
        await this.manager.deleteSession(sessionId);
        return noContent(res);
      }
      if (req.method === "PATCH") {
        const body = JSON.parse((await readBody(req)) || "{}") as { title?: string };
        if (!body.title) return json(res, 400, { error: "title is required" });
        await this.manager.setTitle(sessionId, body.title);
        return noContent(res);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const m = /^\/sessions\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "not found" });
    const sessionId = decodeURIComponent(m[1]!);
    const action = m[2]!;

    if (req.method === "GET") {
      if (action === "events") return this.sse(sessionId, res);
      if (action === "messages") {
        const snap = await this.snapshotOf(sessionId);
        if (!snap) return json(res, 404, { error: "not found" });
        return json(res, 200, messagesToParts(sessionId, snap.messages));
      }
      if (action === "checkpoints") return json(res, 200, this.manager.listCheckpoints(sessionId));
      if (action === "permission-profiles")
        return json(res, 200, await this.manager.listPermissionProfiles(sessionId));
    }

    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;

    switch (action) {
      case "send":
        await this.manager.send(
          sessionId,
          String(body.text ?? ""),
          typeof body.model === "string" && body.model ? { model: body.model } : undefined,
        );
        return noContent(res);
      case "interrupt":
        await this.manager.interrupt(sessionId);
        return noContent(res);
      case "undo":
        return json(
          res,
          200,
          await this.manager.undo(
            sessionId,
            typeof body.checkpointId === "string" ? body.checkpointId : undefined,
            body.mode === "conversation" || body.mode === "both" ? body.mode : "files",
          ),
        );
      case "compact":
        return json(res, 200, await this.manager.compact(sessionId));
      case "fork":
        return json(
          res,
          200,
          await this.manager.forkSession(sessionId, {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.upToMessage === "number" ? { upToMessage: body.upToMessage } : {}),
          }),
        );
      case "permission": {
        const answered = await this.manager.answerPermission(
          sessionId,
          String(body.permId ?? ""),
          body.decision as PermissionDecisionKind,
        );
        return json(res, 200, { answered });
      }
      case "permission-mode":
        await this.manager.setPermissionMode(sessionId, body.mode as PermissionMode);
        return noContent(res);
      case "permission-profile": {
        const mode = await this.manager.setPermissionProfile(sessionId, String(body.name ?? ""));
        return json(res, 200, { mode });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  /** live 快照；未加载则经 resumeSession 懒载入（不存在返回 undefined）。 */
  private async snapshotOf(sessionId: string) {
    const live = this.manager.peek(sessionId);
    if (live) return live;
    try {
      await this.manager.resumeSession(sessionId);
    } catch {
      return undefined;
    }
    return this.manager.peek(sessionId);
  }

  /** 取（或建）会话的共享事件扇出。 */
  private async feed(sessionId: string): Promise<SessionFeed> {
    const existing = this.feeds.get(sessionId);
    if (existing) return existing;
    const writers = new Set<(ev: EventEnvelope) => void>();
    const projector = new PartsProjector(sessionId);
    const broadcast = (ev: EventEnvelope) => {
      for (const w of writers) w(ev);
    };
    const handle = await this.manager.open(sessionId, (event: SessionEvent) => {
      broadcast(envelope("session.event", { sessionId, event }));
      for (const named of this.namedEvents(sessionId, projector, event)) broadcast(named);
    });
    const feed: SessionFeed = {
      writers,
      close: () => {
        handle.close();
        this.feeds.delete(sessionId);
      },
    };
    this.feeds.set(sessionId, feed);
    return feed;
  }

  /** SessionEvent → 命名细粒度事件（含 Message+Parts 投影）。 */
  private namedEvents(
    sessionId: string,
    projector: PartsProjector,
    event: SessionEvent,
  ): EventEnvelope[] {
    switch (event.type) {
      case "agent":
        return projector
          .handle(event.event)
          .map((p) => envelope(p.type, p.properties as unknown as Record<string, unknown>));
      case "permission_request":
        return [
          envelope("permission.asked", {
            sessionId,
            permId: event.permId,
            toolName: event.toolName,
            ruleKey: event.ruleKey,
          }),
        ];
      case "permission_resolved":
        return [
          envelope("permission.replied", {
            sessionId,
            permId: event.permId,
            decision: event.decision,
          }),
        ];
      case "title":
        return [envelope("session.updated", { sessionId, title: event.title })];
      case "state":
        return [envelope("session.status", { sessionId, running: event.running })];
      case "reverted": {
        const { type: _type, ...rest } = event;
        return [envelope("session.reverted", { sessionId, ...rest })];
      }
      default:
        return [];
    }
  }

  /** 订阅会话：server.connected → session.snapshot 先行，之后实时事件；断开即退订。 */
  private async sse(sessionId: string, res: http.ServerResponse): Promise<void> {
    const feed = await this.feed(sessionId);
    const snapshot = this.manager.peek(sessionId);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    sseWrite(res, envelope("server.connected", { protocol: PROTOCOL_VERSION }));
    sseWrite(res, envelope("session.snapshot", { sessionId, snapshot }));

    const writer = (ev: EventEnvelope) => sseWrite(res, ev);
    feed.writers.add(writer);
    const heartbeat = setInterval(() => sseWrite(res, envelope("server.heartbeat", {})), 30_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      feed.writers.delete(writer);
      if (feed.writers.size === 0) feed.close();
      this.sseCleanups.delete(cleanup);
      res.end();
    };
    this.sseCleanups.add(cleanup);
    res.on("close", cleanup);
  }
}
