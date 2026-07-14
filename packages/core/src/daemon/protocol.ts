/**
 * 守护进程协议 —— NDJSON over unix socket。
 *
 * 关键改动（相较旧版）：会话事件不再绑定发起 send 的请求，而是走 subscribe 广播。
 * 一个连接 open(subscribe) 某会话后，该会话的所有事件都推给它 —— 无论是谁触发的。
 * 这让多个连接（CLI + App）观察/接管同一会话成为可能。
 */

import type { SessionEvent, SessionSnapshot, SessionSummary } from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";

// ---------- 客户端 → 守护进程 ----------

export type ClientRequest =
  | { id: number; method: "listSessions" }
  | { id: number; method: "createSession"; cwd: string; model: string; title?: string }
  /** 订阅会话事件；结果里带 snapshot，之后经 session_event 帧推送 */
  | { id: number; method: "open"; sessionId: string }
  /** 取消订阅 */
  | { id: number; method: "close"; sessionId: string }
  | { id: number; method: "send"; sessionId: string; text: string }
  | { id: number; method: "interrupt"; sessionId: string }
  | { id: number; method: "answerPermission"; sessionId: string; permId: string; decision: PermissionDecisionKind };

// ---------- 守护进程 → 客户端 ----------

export type ServerFrame =
  | { type: "result"; id: number; ok: true; data: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  /** 已订阅会话的实时事件（与触发它的 request 解耦） */
  | { type: "session_event"; sessionId: string; event: SessionEvent };

// 复用 SessionManager 的类型作为线上数据形状
export type { SessionSnapshot, SessionSummary };

// ---------- NDJSON 编解码 ----------

export function encodeFrame(frame: ServerFrame | ClientRequest): string {
  return JSON.stringify(frame) + "\n";
}

/** 把字节流按行切成完整 JSON 对象；返回解析结果 + 剩余未完成 buffer */
export function decodeLines<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (line.trim()) messages.push(JSON.parse(line) as T);
  }
  return { messages, rest };
}
