/**
 * SessionManager 测试：验证 pub/sub 总线的核心承诺 ——
 *   - 多订阅者都收到同一批事件（共享会话/接管的基础）
 *   - 权限请求广播，任一订阅者可裁决
 *   - subscribe 立即回放 snapshot（晚加入者对齐）
 *   - create/resume/list 生命周期
 * 全离线（脚本化 provider）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionEvent } from "./session-manager.js";
import { SessionStore } from "./session.js";
import type { Provider, StreamEvent, ChatMessage } from "./types.js";

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content) if (part.type === "text") yield { type: "text_delta", text: part.text };
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 },
      };
    },
  };
}

async function mgr(dir: string, provider: Provider) {
  return new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    now: () => 1_700_000_000_000,
    rand: () => 0.5,
  });
}

test("SessionManager: 多订阅者都收到同一批事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-sm-"));
  const m = await mgr(dir, scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "hi there" }] }],
  ]));
  const s = await m.createSession({ cwd: dir, model: "scripted", title: "多订阅" });

  const a: SessionEvent[] = [];
  const b: SessionEvent[] = [];
  const subA = await m.open(s.id, (ev) => a.push(ev));
  const subB = await m.open(s.id, (ev) => b.push(ev));

  await m.send(s.id, "hello");

  // 两个订阅者都拿到 state(running) + agent 文本 + done
  const textOf = (arr: SessionEvent[]) =>
    arr.filter((e) => e.type === "agent" && e.event.type === "text").map((e: any) => e.event.text).join("");
  assert.equal(textOf(a), "hi there");
  assert.equal(textOf(b), "hi there");
  assert.ok(a.some((e) => e.type === "state" && e.running === true));
  assert.ok(a.some((e) => e.type === "state" && e.running === false));
  assert.ok(a.some((e) => e.type === "agent" && e.event.type === "done"));
  assert.ok(b.some((e) => e.type === "agent" && e.event.type === "done"));

  subA.close();
  subB.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: 权限广播，任一订阅者可裁决", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-sm-"));
  const m = await mgr(dir, scriptedProvider([
    [{ role: "assistant", content: [
      { type: "tool_call", id: "c1", name: "write", args: { path: "x.txt", content: "data" } },
    ] }],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]));
  const s = await m.createSession({ cwd: dir, model: "scripted" });

  const events: SessionEvent[] = [];
  await m.open(s.id, (ev) => {
    events.push(ev);
    // 订阅者 A 看到权限请求就批准（模拟 UI 交互）
    if (ev.type === "permission_request") void m.answerPermission(s.id, ev.permId, "allow");
  });

  await m.send(s.id, "写文件");

  // permId 应等于工具调用 id（供 UI 关联）
  const perm = events.find((e) => e.type === "permission_request") as any;
  assert.equal(perm.permId, "c1");
  assert.equal(perm.toolName, "write");
  // 文件真的写了
  assert.equal(await fs.readFile(path.join(dir, "x.txt"), "utf8"), "data");
  // 有成功的工具结果
  assert.ok(events.some((e) => e.type === "agent" && e.event.type === "tool_result" && !e.event.isError));

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: subscribe 立即回放 snapshot；resume 载入历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-sm-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  // 预置一个已有会话
  const meta = await store.create({ id: "s_pre", cwd: dir, model: "scripted", title: "旧会话" });
  await store.append("s_pre", { role: "user", content: [{ type: "text", text: "旧问题" }] });
  await store.append("s_pre", { role: "assistant", content: [{ type: "text", text: "旧回答" }] });

  const m = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "续接" }] }]]), model: "scripted" }),
  });

  // list 能看到磁盘会话
  const list = await m.listSessions();
  assert.equal(list.find((x) => x.id === "s_pre")?.title, "旧会话");

  // open 返回的 snapshot 带历史
  const sub = await m.open("s_pre", () => {});
  assert.equal(sub.snapshot.messages.length, 2);
  assert.equal(sub.snapshot.running, false);
  assert.equal((sub.snapshot.messages[0]!.content[0] as any).text, "旧问题");

  // 续接后仍持久化
  await m.send("s_pre", "新问题");
  const reloaded = await store.load("s_pre");
  assert.equal(reloaded.messages.length, 4);

  sub.close();
  await fs.rm(dir, { recursive: true, force: true });
});
