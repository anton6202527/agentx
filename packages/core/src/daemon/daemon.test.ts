/**
 * 守护进程端到端测试：真 unix socket，验证新的 subscribe/broadcast 架构。
 * 重点验证旧版做不到的事：
 *   - 两个客户端 open 同一会话，一个 send，两个都收到事件（共享/接管）
 *   - 权限经协议广播，任一客户端裁决
 *   - open 立即拿到 snapshot（resume 渲染）
 *   - DaemonClient 满足 SessionHost 接口，与 LocalSessionHost 可换
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonServer } from "./server.js";
import { DaemonClient } from "./client.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import { SessionStore } from "../session.js";
import type { SessionHost } from "../host.js";
import type { Provider, StreamEvent, ChatMessage } from "../index.js";

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
        usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 },
      };
    },
  };
}

async function startDaemon(dir: string, provider: Provider) {
  const sockPath = path.join(dir, "d.sock");
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new DaemonServer({ manager });
  await server.listen(sockPath);
  return { server, sockPath };
}

test("daemon: 两个客户端共享同一会话，一个 send 两个都收事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-daemon-"));
  const { server, sockPath } = await startDaemon(dir, scriptedProvider([
    [{ role: "assistant", content: [
      { type: "text", text: "写文件" },
      { type: "tool_call", id: "c1", name: "write", args: { path: "d.txt", content: "shared" } },
    ] }],
    [{ role: "assistant", content: [{ type: "text", text: "完成" }] }],
  ]));

  // 客户端 A 建会话并订阅
  const clientA: SessionHost = await DaemonClient.connect(sockPath);
  const clientB: SessionHost = await DaemonClient.connect(sockPath);
  const meta = await clientA.createSession({ cwd: dir, model: "scripted", title: "共享会话" });

  const eventsA: SessionEvent[] = [];
  const eventsB: SessionEvent[] = [];
  // B 的 done 是跨 socket 异步到达的，用 promise 等它，避免 send 一 resolve 就断言的竞态
  let resolveBDone: () => void;
  const bDone = new Promise<void>((r) => (resolveBDone = r));

  await clientA.open(meta.id, (ev) => {
    eventsA.push(ev);
    if (ev.type === "permission_request") void clientA.answerPermission(meta.id, ev.permId, "allow");
  });
  await clientB.open(meta.id, (ev) => {
    eventsB.push(ev); // B 只观察
    if (ev.type === "agent" && ev.event.type === "done") resolveBDone();
  });

  // A 触发 send，并等 B 也收到 done
  await clientA.send(meta.id, "写 d.txt");
  await bDone;

  // B（没发 send）收到了完整事件流：权限广播 + done
  assert.ok(eventsB.some((e) => e.type === "permission_request"), "B 应看到权限请求广播");
  assert.ok(
    eventsB.some((e) => e.type === "agent" && e.event.type === "tool_result" && !e.event.isError),
    "B 应看到成功的工具结果",
  );
  // 文件在 daemon 侧真的写了
  assert.equal(await fs.readFile(path.join(dir, "d.txt"), "utf8"), "shared");

  (clientA as SessionHost).dispose();
  (clientB as SessionHost).dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: open 返回 snapshot；resume 已有会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-daemon-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "s_pre", cwd: dir, model: "scripted", title: "旧会话" });
  await store.append("s_pre", { role: "user", content: [{ type: "text", text: "旧消息" }] });
  await store.append("s_pre", { role: "assistant", content: [{ type: "text", text: "旧回复" }] });

  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "ok" }] }]]), model: "scripted" }),
  });
  const server = new DaemonServer({ manager });
  const sockPath = path.join(dir, "d.sock");
  await server.listen(sockPath);

  const client = await DaemonClient.connect(sockPath);
  const list = await client.listSessions();
  assert.equal(list.find((x) => x.id === "s_pre")?.title, "旧会话");

  const handle = await client.open("s_pre", () => {});
  assert.equal(handle.snapshot.messages.length, 2);
  assert.equal((handle.snapshot.messages[0]!.content[0] as any).text, "旧消息");

  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
