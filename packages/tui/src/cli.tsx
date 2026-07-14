#!/usr/bin/env tsx
/**
 * agentx TUI 入口。
 *
 * 前端只认 SessionHost；这里决定用哪种实现：
 *   默认         → LocalSessionHost（进程内 SessionManager，零 IPC）
 *   --daemon [P] → 连 daemon 的 DaemonClient（跨进程共享会话，可与 App/其他 CLI 接管）
 *
 *   agentx [--model provider/model] [--cwd DIR] [--daemon [SOCKET]] [--resume ID]
 */

import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { render } from "ink";
import {
  createProvider,
  SessionManager,
  SessionStore,
  LocalSessionHost,
  DaemonClient,
  type SessionHost,
} from "@agentx/core";
import { App } from "./app.js";

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const daemonIdx = argv.indexOf("--daemon");
  return {
    model: get("--model") ?? "anthropic/claude-opus-4-8",
    cwd: get("--cwd") ?? process.cwd(),
    resume: get("--resume"),
    daemon: daemonIdx >= 0,
    // --daemon 后若跟的不是另一个 flag，则作为 socket 路径
    socket:
      daemonIdx >= 0 && argv[daemonIdx + 1] && !argv[daemonIdx + 1]!.startsWith("--")
        ? argv[daemonIdx + 1]!
        : path.join(os.tmpdir(), "agentx.sock"),
  };
}

async function buildHost(args: ReturnType<typeof parseArgs>): Promise<SessionHost> {
  if (args.daemon) {
    return DaemonClient.connect(args.socket);
  }
  const manager = new SessionManager({
    store: new SessionStore(path.join(os.homedir(), ".agentx", "sessions")),
    resolveProvider: (model) => createProvider(model),
    compaction: true,
  });
  return new LocalSessionHost(manager);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 校验 provider（本地模式下尽早报错）
  if (!args.daemon) {
    try {
      createProvider(args.model);
    } catch (err) {
      console.error(String((err as Error).message));
      process.exit(1);
    }
  }

  const host = await buildHost(args).catch((err) => {
    console.error(`无法建立会话宿主: ${(err as Error).message}`);
    process.exit(1);
  });

  // 选定会话：--resume 用已有，否则新建
  const sessionId = args.resume
    ? (await host.open(args.resume, () => {})).snapshot.meta.id
    : (await host.createSession({ cwd: args.cwd, model: args.model })).id;

  render(<App host={host} cwd={args.cwd} model={args.model} sessionId={sessionId} />);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
