/**
 * 时间有序前缀 ID（对齐 opencode 的 id 方案，零依赖）。
 *
 * 形态：`<prefix>_<12 hex 单调时间戳><12 base62 随机>`
 *   - 时间戳部分 = (ms 时间戳 << 12) + 进程内单调计数器，保证同进程内严格递增，
 *     字典序即时间序（message/part/event 都用升序）。
 *   - 随机后缀防跨进程碰撞。
 *
 * 会话 id 沿用既有 `newSessionId`（session.ts），此模块只服务消息/part/事件等
 * API 面新增对象。
 */

export type IdPrefix = "msg" | "prt" | "evt" | "per" | "stp";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastCounter = 0n;

function monotonic(nowMs: number): bigint {
  const candidate = BigInt(nowMs) << 12n;
  lastCounter = candidate > lastCounter ? candidate : lastCounter + 1n;
  return lastCounter;
}

function randomSuffix(rand: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[Math.floor(rand() * BASE62.length)];
  return out;
}

/** 生成一个升序（时间正序）ID。now/rand 可注入便于测试。 */
export function createId(
  prefix: IdPrefix,
  now = Date.now(),
  rand: () => number = Math.random,
): string {
  const ts = monotonic(now).toString(16).padStart(12, "0");
  return `${prefix}_${ts}${randomSuffix(rand, 12)}`;
}

/**
 * 从持久化历史重建投影时用的确定性 ID：同一会话同一位置永远得到同一 id，
 * 保证重复 GET /sessions/:id/messages 结果稳定。
 */
export function deterministicId(prefix: IdPrefix, sessionId: string, ...indices: number[]): string {
  const pos = indices.map((i) => i.toString(36).padStart(4, "0")).join("");
  return `${prefix}_${sessionId}_${pos}`;
}
