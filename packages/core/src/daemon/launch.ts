#!/usr/bin/env tsx
/**
 * 守护进程启动器 —— 起一个监听 unix socket 的 DaemonServer（内含 SessionManager）。
 * App / 多个 CLI 前端连它即可共享会话。
 *
 *   tsx src/daemon/launch.ts [--socket PATH] [--sessions DIR]
 */

import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { DaemonServer } from "./server.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session.js";
import { createProvider } from "../provider/registry.js";

export function defaultSocketPath(): string {
  return path.join(os.tmpdir(), "agentx.sock");
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (f: string, d: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const socketPath = get("--socket", defaultSocketPath());
  const sessionsDir = get("--sessions", path.join(os.homedir(), ".agentx", "sessions"));

  await fs.rm(socketPath, { force: true }); // 清理旧 socket

  const manager = new SessionManager({
    store: new SessionStore(sessionsDir),
    resolveProvider: (model) => createProvider(model),
    compaction: true,
  });
  const server = new DaemonServer({ manager });
  await server.listen(socketPath);
  console.log(`agentx daemon 监听于 ${socketPath}（会话目录 ${sessionsDir}）`);

  const shutdown = async () => {
    await server.close();
    await fs.rm(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
