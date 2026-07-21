import { test } from "node:test";
import assert from "node:assert/strict";
import { createId, deterministicId } from "./id.js";

test("createId: 前缀正确、同进程严格递增（字典序即时间序）", () => {
  const a = createId("msg", 1000, () => 0.5);
  const b = createId("msg", 1000, () => 0.5); // 同一毫秒 → 计数器兜底
  const c = createId("msg", 2000, () => 0.5);
  assert.match(a, /^msg_[0-9a-f]{12}[0-9A-Za-z]{12}$/);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
});

test("createId: 时钟回拨不破坏单调性", () => {
  const a = createId("evt", 5000);
  const b = createId("evt", 1000); // 回拨
  assert.ok(a < b);
});

test("deterministicId: 同位置恒等、不同位置不同", () => {
  const x = deterministicId("prt", "s_abc", 1, 2);
  assert.equal(x, deterministicId("prt", "s_abc", 1, 2));
  assert.notEqual(x, deterministicId("prt", "s_abc", 1, 3));
  assert.notEqual(x, deterministicId("prt", "s_other", 1, 2));
});
