/**
 * SessionHost —— 前端（TUI/App/CI）唯一面对的契约。
 *
 * 这是架构的拱心石：前端只认这个接口，不关心 core 是「进程内」还是「socket 那头」。
 *   - LocalSessionHost：直接包 SessionManager（单进程，零 IPC 开销）
 *   - RemoteSessionHost：daemon 客户端（见 daemon/client.ts），跨进程共享会话
 * 两者行为等价，可互换 —— 正如 core 对 UI 无关，前端也对传输无关。
 */

import type { SessionEvent, SessionSnapshot, SessionSummary, SessionManager } from "./session-manager.js";

export type PermissionDecisionKind = "allow" | "allow_remember" | "deny";

export interface OpenHandle {
  snapshot: SessionSnapshot;
  /** 取消订阅 */
  close(): void;
}

export interface SessionHost {
  listSessions(): Promise<SessionSummary[]>;
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary>;
  /** 订阅一个会话：立即拿 snapshot，之后经 listener 实时收事件 */
  open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle>;
  /** 发消息驱动 loop；事件经 open 的 listener 回流；resolve 于本次 loop 结束 */
  send(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  answerPermission(sessionId: string, permId: string, decision: PermissionDecisionKind): Promise<void>;
  /** 释放资源（远程实现断开 socket；本地实现无操作） */
  dispose(): void;
}

/** 进程内实现：直接委托给 SessionManager */
export class LocalSessionHost implements SessionHost {
  constructor(private manager: SessionManager) {}

  listSessions(): Promise<SessionSummary[]> {
    return this.manager.listSessions();
  }
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.manager.createSession(input);
  }
  async open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    return this.manager.open(sessionId, listener);
  }
  send(sessionId: string, text: string): Promise<void> {
    return this.manager.send(sessionId, text);
  }
  interrupt(sessionId: string): Promise<void> {
    return this.manager.interrupt(sessionId);
  }
  async answerPermission(sessionId: string, permId: string, decision: PermissionDecisionKind): Promise<void> {
    await this.manager.answerPermission(sessionId, permId, decision);
  }
  dispose(): void {
    /* 进程内无需释放 */
  }
}
