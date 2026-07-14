/**
 * 守护进程客户端 = RemoteSessionHost —— 实现 SessionHost 接口，与 LocalSessionHost 等价可换。
 *
 * 事件路由：daemon 推来的 session_event 帧按 sessionId 分发给对应 open 时注册的 listener。
 * request/result 用自增 id 关联。
 */

import * as net from "node:net";
import type { SessionEvent, SessionSnapshot, SessionSummary } from "../session-manager.js";
import type { SessionHost, OpenHandle, PermissionDecisionKind } from "../host.js";
import {
  decodeLines,
  encodeFrame,
  type ClientRequest,
  type ServerFrame,
} from "./protocol.js";

export class DaemonClient implements SessionHost {
  private sock: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, (ev: SessionEvent) => void>();

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk) => this.onData(chunk.toString()));
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("daemon 连接已断开"));
      this.pending.clear();
    });
  }

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((res, rej) => {
      const sock = net.createConnection(socketPath, () => res(new DaemonClient(sock)));
      sock.once("error", rej);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest } = decodeLines<ServerFrame>(this.buffer);
    this.buffer = rest;
    for (const frame of messages) this.dispatch(frame);
  }

  private dispatch(frame: ServerFrame): void {
    if (frame.type === "result") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(new Error(frame.error));
    } else if (frame.type === "session_event") {
      this.listeners.get(frame.sessionId)?.(frame.event);
    }
  }

  private request<T>(build: (id: number) => ClientRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock.write(encodeFrame(build(id)));
    });
  }

  // ---------- SessionHost ----------

  listSessions(): Promise<SessionSummary[]> {
    return this.request((id) => ({ id, method: "listSessions" }));
  }

  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.request((id) => ({
      id,
      method: "createSession",
      cwd: input.cwd,
      model: input.model,
      ...(input.title ? { title: input.title } : {}),
    }));
  }

  async open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    this.listeners.set(sessionId, listener);
    const { snapshot } = await this.request<{ snapshot: SessionSnapshot }>((id) => ({
      id,
      method: "open",
      sessionId,
    }));
    return {
      snapshot,
      close: () => {
        this.listeners.delete(sessionId);
        void this.request((id) => ({ id, method: "close", sessionId }));
      },
    };
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.request((id) => ({ id, method: "send", sessionId, text }));
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request((id) => ({ id, method: "interrupt", sessionId }));
  }

  async answerPermission(sessionId: string, permId: string, decision: PermissionDecisionKind): Promise<void> {
    await this.request((id) => ({ id, method: "answerPermission", sessionId, permId, decision }));
  }

  dispose(): void {
    this.sock.end();
  }
}
