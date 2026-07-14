/**
 * TUI 冒烟测试：真实 App 挂在 LocalSessionHost（进程内 SessionManager + 脚本化 provider）上，
 * 走完 键入 → 权限弹窗 → 批准 → 文件落盘 → 渲染，并验证 /resume 回显历史。
 * 全离线。因为 App 只依赖 SessionHost，这套测试同时覆盖了 core 的整条新架构。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import {
  SessionManager,
  SessionStore,
  LocalSessionHost,
  type Provider,
  type StreamEvent,
  type ChatMessage,
} from "@agentx/core";
import { App } from "./app.js";

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
        usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 0 },
      };
    },
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("TUI: 键入 → 授权 → 文件落盘 → 渲染（走 SessionHost）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-tui-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({
      provider: scriptedProvider([
        [{ role: "assistant", content: [
          { type: "text", text: "创建文件中。" },
          { type: "tool_call", id: "c1", name: "write", args: { path: "note.txt", content: "hello" } },
        ] }],
        [{ role: "assistant", content: [{ type: "text", text: "完成，已写入 note.txt。" }] }],
      ]),
      model: "scripted",
    }),
  });
  const host = new LocalSessionHost(manager);
  const meta = await host.createSession({ cwd: dir, model: "scripted", title: "TUI 测试" });

  const { stdin, lastFrame } = render(
    <App host={host} cwd={dir} model="scripted" sessionId={meta.id} />,
  );
  await tick(); // 等 open/subscribe 完成

  for (const ch of "写个 note.txt") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(100);

  assert.match(lastFrame() ?? "", /授权请求/);
  assert.match(lastFrame() ?? "", /write/);

  stdin.write("y"); // 批准
  await tick(150);

  assert.equal(await fs.readFile(path.join(dir, "note.txt"), "utf8"), "hello");
  const frame = lastFrame() ?? "";
  assert.match(frame, /完成，已写入/);
  assert.match(frame, /out \d+ tokens/);

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: /resume 回显已有会话的历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-tui-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  // 预置一个有历史的会话
  await store.create({ id: "s_old", cwd: dir, model: "scripted", title: "旧会话" });
  await store.append("s_old", { role: "user", content: [{ type: "text", text: "先前的问题" }] });
  await store.append("s_old", { role: "assistant", content: [{ type: "text", text: "先前的回答" }] });

  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const host = new LocalSessionHost(manager);
  // 新建一个空会话作为起点
  const start = await host.createSession({ cwd: dir, model: "scripted" });

  const { stdin, lastFrame } = render(
    <App host={host} cwd={dir} model="scripted" sessionId={start.id} />,
  );
  await tick();

  // /resume 到旧会话
  for (const ch of "/resume s_old") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(120);

  // 界面回显了旧会话的历史
  const frame = lastFrame() ?? "";
  assert.match(frame, /先前的问题/);
  assert.match(frame, /先前的回答/);
  assert.match(frame, /s_old/); // 底部状态栏显示当前会话

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: /sessions 列出会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-tui-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "s_a", cwd: dir, model: "scripted", title: "会话A" });

  const manager = new SessionManager({ store, resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }) });
  const host = new LocalSessionHost(manager);
  const start = await host.createSession({ cwd: dir, model: "scripted", title: "起点" });

  const { stdin, lastFrame } = render(<App host={host} cwd={dir} model="scripted" sessionId={start.id} />);
  await tick();
  for (const ch of "/sessions") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(80);

  const frame = lastFrame() ?? "";
  assert.match(frame, /会话列表/);
  assert.match(frame, /会话A/);
  assert.match(frame, /起点/);

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});
