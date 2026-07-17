/**
 * HTTP + SSE 传输端到端测试：真 http server（随机端口）+ HttpSessionHost。
 * 验证与 socket daemon 等价的核心语义：snapshot 先行、事件广播、多客户端共享，
 * 以及 HTTP 版独有的 permission-mode / permission-profile 端点与 token 鉴权。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpDaemonServer } from "./http-server.js";
import { HttpSessionHost, parseSseChunk } from "./http-client.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import { SessionStore } from "../session.js";
import type { ChatMessage, Provider, StreamEvent } from "../index.js";

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content)
        if (part.type === "text") yield { type: "text_delta", text: part.text };
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 },
      };
    },
  };
}

async function startHttp(dir: string, provider: Provider, token?: string) {
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager, ...(token ? { token } : {}) });
  await server.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.port()}` };
}

test("sse 解析：分帧/多 data 行/心跳注释/半帧留存", () => {
  const input =
    ": ping\n\n" +
    "event: snapshot\ndata: {\"a\":1}\n\n" +
    "event: session\ndata: line1\ndata: line2\n\n" +
    "event: session\ndata: {\"partial\"";
  const { frames, rest } = parseSseChunk(input);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { event: "snapshot", data: '{"a":1}' });
  assert.deepEqual(frames[1], { event: "session", data: "line1\nline2" });
  assert.match(rest, /partial/);
});

test("http host: 建会话 → SSE snapshot 先行 → send 两个客户端都收事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "HTTP 回答" }] }]]),
  );
  const a = new HttpSessionHost({ baseUrl });
  const b = new HttpSessionHost({ baseUrl });
  try {
    const meta = await a.createSession({ cwd: dir, model: "scripted", title: "http 会话" });
    assert.ok((await a.listSessions()).some((s) => s.id === meta.id));

    const eventsA: SessionEvent[] = [];
    const eventsB: SessionEvent[] = [];
    const ha = await a.open(meta.id, (ev) => eventsA.push(ev));
    const hb = await b.open(meta.id, (ev) => eventsB.push(ev));
    assert.equal(ha.snapshot.meta.id, meta.id); // snapshot 先行契约
    assert.equal(hb.snapshot.meta.id, meta.id);

    await a.send(meta.id, "你好");
    // send resolve 在 drive 收尾后；SSE 推送是异步网络，稍等片刻收齐
    await new Promise((r) => setTimeout(r, 150));
    const textOf = (evs: SessionEvent[]) =>
      evs
        .filter((e) => e.type === "agent")
        .map((e) => JSON.stringify(e))
        .join("");
    assert.match(textOf(eventsA), /HTTP 回答/, "发起方应收到事件");
    assert.match(textOf(eventsB), /HTTP 回答/, "观察方也应收到广播事件");

    ha.close();
    hb.close();
  } finally {
    a.dispose();
    b.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: permission-mode / permission-profile 端到端可切", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    const profiles = await host.listPermissionProfiles(meta.id);
    assert.ok(profiles.readonly && profiles.full, "应能列出内置档位");

    assert.equal(await host.setPermissionProfile(meta.id, "readonly"), "plan");
    await host.setPermissionMode(meta.id, "default"); // 直接切模式也通
    await assert.rejects(() => host.setPermissionProfile(meta.id, "nope"), /nope/);
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: 配了 token 后无凭据请求 401，带凭据可用（SSE 走查询参数）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]), "s3cret");
  const anon = new HttpSessionHost({ baseUrl });
  const auth = new HttpSessionHost({ baseUrl, token: "s3cret" });
  try {
    await assert.rejects(() => anon.listSessions(), /unauthorized|401/);
    const meta = await auth.createSession({ cwd: dir, model: "scripted" });
    const handle = await auth.open(meta.id, () => {});
    assert.equal(handle.snapshot.meta.id, meta.id);
    handle.close();
  } finally {
    anon.dispose();
    auth.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: undo 无快照时报错经 HTTP 透传", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    await assert.rejects(() => host.undo(meta.id));
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
