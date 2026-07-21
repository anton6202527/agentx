/**
 * SDK 集成测试：真 HttpDaemonServer（随机端口）+ createAnicodeClient。
 * 覆盖 REST 资源模型、Message+Parts 投影读取、SSE 信封订阅、错误与鉴权。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HttpDaemonServer,
  SessionManager,
  SessionStore,
  type ChatMessage,
  type Provider,
  type StreamEvent,
} from "@anicode/core";
import { createAnicodeClient, AnicodeApiError, type EventEnvelope } from "./index.js";

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

async function startServer(dir: string, provider: Provider, token?: string) {
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager, ...(token ? { token } : {}) });
  await server.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.port()}` };
}

test("sdk: 会话生命周期 + messages 投影 + doc/health", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "SDK 回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const health = await client.global.health();
    assert.equal(health.ok, true);
    assert.equal(health.name, "anicode");

    const doc = await client.global.doc();
    assert.equal((doc as { openapi: string }).openapi, "3.1.0");

    const meta = await client.session.create({ cwd: dir, model: "scripted", title: "sdk 会话" });
    assert.ok((await client.session.list()).some((s) => s.id === meta.id));

    await client.session.send(meta.id, "你好");

    const snap = await client.session.get(meta.id);
    assert.equal(snap.meta.id, meta.id);
    assert.equal(snap.running, false);

    const messages = await client.session.messages(meta.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.info.role, "user");
    const assistant = messages[1]!;
    assert.equal(assistant.info.role, "assistant");
    assert.ok(assistant.parts.some((p) => p.type === "text" && p.text === "SDK 回答"));

    await client.session.setTitle(meta.id, "改名了");
    assert.equal((await client.session.list()).find((s) => s.id === meta.id)?.title, "改名了");

    assert.deepEqual(await client.session.checkpoints(meta.id), []);

    const fork = await client.session.fork(meta.id, { title: "分叉" });
    assert.notEqual(fork.id, meta.id);

    await client.session.delete(meta.id);
    assert.ok(!(await client.session.list()).some((s) => s.id === meta.id));
    await assert.rejects(
      () => client.session.get(meta.id),
      (err: unknown) => err instanceof AnicodeApiError && err.status === 404,
    );
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: event.subscribe —— 信封序保证与 parts 投影事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "订阅回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const seen: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of client.event.subscribe(meta.id, { signal: ac.signal }))
          seen.push(ev);
      } catch {
        /* abort 收尾 */
      }
    })();

    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen[0]?.type, "server.connected");
    assert.equal(seen[1]?.type, "session.snapshot");

    await client.session.send(meta.id, "你好");
    await new Promise((r) => setTimeout(r, 200));

    const types = seen.map((e) => e.type);
    assert.ok(types.includes("message.updated"));
    assert.ok(types.includes("message.part.updated"));
    assert.ok(
      seen.some(
        (e) =>
          e.type === "message.part.delta" &&
          String((e.properties as { delta?: string }).delta).includes("订阅回答"),
      ),
    );
    assert.ok(types.includes("session.status"));

    ac.abort();
    await consumer;
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: token 鉴权 —— 无凭据 401，带凭据可用（SSE 走查询参数）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(dir, scriptedProvider([]), "s3cret");
  const anon = createAnicodeClient({ baseUrl });
  const auth = createAnicodeClient({ baseUrl, token: "s3cret" });
  try {
    await assert.rejects(
      () => anon.session.list(),
      (err: unknown) => err instanceof AnicodeApiError && err.status === 401,
    );
    const meta = await auth.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const first: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of auth.event.subscribe(meta.id, { signal: ac.signal })) {
          first.push(ev);
          if (first.length >= 1) ac.abort();
        }
      } catch {
        /* abort 收尾 */
      }
    })();
    for (let i = 0; i < 50 && first.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(first[0]?.type, "server.connected");
    await consumer;
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: 权限域 —— listProfiles/setProfile/setMode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(dir, scriptedProvider([]));
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const profiles = await client.permission.listProfiles(meta.id);
    assert.ok(profiles.readonly && profiles.full);
    assert.equal(await client.permission.setProfile(meta.id, "readonly"), "plan");
    await client.permission.setMode(meta.id, "default");
    await assert.rejects(() => client.permission.setProfile(meta.id, "nope"));
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: event.subscribeAll —— 全局 firehose 跨会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "全局回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const seen: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of client.event.subscribeAll({ signal: ac.signal })) {
          seen.push(ev);
          if (seen.some((e) => e.type === "message.updated")) ac.abort();
        }
      } catch {
        /* abort 收尾 */
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await client.session.send(meta.id, "你好");
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();
    await consumer;
    assert.equal(seen[0]?.type, "server.connected");
    assert.ok(!seen.some((e) => e.type === "session.snapshot"), "firehose 不发快照");
    assert.ok(
      seen.some((e) => e.type === "session.event" && e.properties.sessionId === meta.id),
      "带 sessionId 广播",
    );
    assert.ok(
      seen.some((e) => e.type === "message.updated"),
      "含 parts 投影",
    );
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
