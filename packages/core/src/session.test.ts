import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, newSessionId } from "./session.js";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, ChatMessage } from "./types.js";

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function drain(agent: Agent, text: string) {
  for await (const _ of agent.send(text)) void _;
}

test("SessionStore: create/append/load/list 往返", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-sess-"));
  const store = new SessionStore(dir);
  const id = newSessionId(Date.now(), Math.random);
  const meta = await store.create({ id, cwd: "/x", model: "m", title: "测试会话" });
  assert.equal(meta.id, id);

  await store.append(id, { role: "user", content: [{ type: "text", text: "hi" }] });
  await store.append(id, { role: "assistant", content: [{ type: "text", text: "hello" }] });

  const data = await store.load(id);
  assert.equal(data.title, "测试会话");
  assert.equal(data.messages.length, 2);
  assert.equal((data.messages[0]!.content[0] as any).text, "hi");

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, id);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: 对话自动持久化，可 resume 续接", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-sess-"));
  const store = new SessionStore(dir);
  const id = newSessionId(Date.now(), Math.random);
  const meta = await store.create({ id, cwd: dir, model: "m" });

  // 第一段会话
  const agent1 = new Agent({
    provider: scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "记住：项目叫 X" }] }]]),
    model: "m",
    cwd: dir,
    projectMemory: false,
    persistence: { store, meta },
  });
  await drain(agent1, "项目叫什么，先记住");

  // 落盘应有：user + assistant = 2 条
  const saved = await store.load(id);
  assert.equal(saved.messages.length, 2);

  // resume：新 Agent 载入历史续接
  const agent2 = new Agent({
    provider: scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "项目叫 X" }] }]]),
    model: "m",
    cwd: dir,
    projectMemory: false,
    persistence: { store, meta, resumeMessages: saved.messages },
  });
  assert.equal(agent2.messages.length, 2); // 已载入历史
  await drain(agent2, "项目叫什么");

  // 续接后文件应有 4 条（2 旧 + 2 新），且不重复旧消息
  const after = await store.load(id);
  assert.equal(after.messages.length, 4);
  assert.equal((after.messages[0]!.content[0] as any).text, "hi" === "hi" ? "项目叫什么，先记住" : "");

  await fs.rm(dir, { recursive: true, force: true });
});

test("newSessionId: 时间前缀保证可排序", () => {
  const a = newSessionId(1000, () => 0.1);
  const b = newSessionId(2000, () => 0.1);
  assert.ok(a < b, `${a} 应小于 ${b}`);
});
