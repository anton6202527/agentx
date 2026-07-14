/**
 * 守护进程服务端 —— SessionManager 之上的一层 socket 转发。
 *
 * 极薄：所有会话逻辑都在 SessionManager。server 只做三件事——
 *   1. 把 ClientRequest 翻译成 manager 调用
 *   2. open 时给该连接挂一个订阅，manager 的会话事件 → session_event 帧
 *   3. 连接断开时清理它的所有订阅
 *
 * 因为逻辑都在 manager，进程内（LocalSessionHost）与跨进程（daemon）行为天然等价。
 */

import * as net from "node:net";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import {
  decodeLines,
  encodeFrame,
  type ClientRequest,
  type ServerFrame,
} from "./protocol.js";

export interface DaemonServerOptions {
  manager: SessionManager;
}

export class DaemonServer {
  private server: net.Server;
  private manager: SessionManager;
  private conns = new Set<net.Socket>();

  constructor(opts: DaemonServerOptions) {
    this.manager = opts.manager;
    this.server = net.createServer((sock) => this.onConnection(sock));
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((res, rej) => {
      this.server.once("error", rej);
      this.server.listen(socketPath, () => res());
    });
  }

  /** 关闭：先断开所有连接（否则 server.close 会等待它们自然结束），再停监听 */
  close(): Promise<void> {
    for (const sock of this.conns) sock.destroy();
    this.conns.clear();
    return new Promise((res) => this.server.close(() => res()));
  }

  private onConnection(sock: net.Socket): void {
    this.conns.add(sock);
    let buffer = "";
    // 该连接的订阅：sessionId → unsubscribe
    const subs = new Map<string, () => void>();
    const write = (frame: ServerFrame) => {
      if (!sock.destroyed) sock.write(encodeFrame(frame));
    };

    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const { messages, rest } = decodeLines<ClientRequest>(buffer);
      buffer = rest;
      for (const req of messages) void this.handle(req, write, subs);
    });
    const cleanup = () => {
      for (const unsub of subs.values()) unsub();
      subs.clear();
      this.conns.delete(sock);
    };
    sock.on("close", cleanup);
    sock.on("error", cleanup);
  }

  private async handle(
    req: ClientRequest,
    write: (f: ServerFrame) => void,
    subs: Map<string, () => void>,
  ): Promise<void> {
    try {
      const data = await this.dispatch(req, write, subs);
      write({ type: "result", id: req.id, ok: true, data });
    } catch (err) {
      write({ type: "result", id: req.id, ok: false, error: String((err as Error).message) });
    }
  }

  private async dispatch(
    req: ClientRequest,
    write: (f: ServerFrame) => void,
    subs: Map<string, () => void>,
  ): Promise<unknown> {
    switch (req.method) {
      case "listSessions":
        return this.manager.listSessions();
      case "createSession":
        return this.manager.createSession({
          cwd: req.cwd,
          model: req.model,
          ...(req.title ? { title: req.title } : {}),
        });
      case "open": {
        if (subs.has(req.sessionId)) return { alreadyOpen: true };
        const listener = (event: SessionEvent) =>
          write({ type: "session_event", sessionId: req.sessionId, event });
        const handle = await this.manager.open(req.sessionId, listener);
        subs.set(req.sessionId, handle.close);
        return { snapshot: handle.snapshot };
      }
      case "close": {
        subs.get(req.sessionId)?.();
        subs.delete(req.sessionId);
        return null;
      }
      case "send":
        await this.manager.send(req.sessionId, req.text);
        return null;
      case "interrupt":
        await this.manager.interrupt(req.sessionId);
        return null;
      case "answerPermission":
        return { answered: await this.manager.answerPermission(req.sessionId, req.permId, req.decision) };
    }
  }
}
