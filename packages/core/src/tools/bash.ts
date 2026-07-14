/**
 * Bash 工具 —— 执行 shell 命令。副作用最大的工具，权限门的主要看护对象。
 *
 * 安全说明（原型级，正式版需上真沙箱）：
 * - 命令在 cwd 下执行
 * - 有超时；abort signal 会 kill 子进程
 * - ruleKey 直接返回命令原文，便于 "Bash(git *)" 这类规则匹配
 * 正式版 TODO：seatbelt(macOS)/landlock(Linux) 收敛可写路径与网络。
 */

import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000; // 截断超长输出，保护上下文

export const bashTool: Tool = {
  readOnly: false,
  def: {
    name: "bash",
    description:
      "在工作目录下执行一条 shell 命令，返回合并的 stdout+stderr 与退出码。用于运行构建、测试、git 等。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout_ms: { type: "number", description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["command"] ?? ""),
  run(input, ctx: ToolContext): Promise<string> {
    const command = String(input["command"] ?? "");
    if (!command) throw new ToolError("command 不能为空");
    const timeout = Math.max(1000, Number(input["timeout_ms"] ?? DEFAULT_TIMEOUT_MS));

    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: ctx.cwd,
        env: process.env,
      });
      let out = "";
      let truncated = false;
      const onData = (buf: Buffer) => {
        if (out.length < MAX_OUTPUT) out += buf.toString();
        else truncated = true;
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ToolError(`命令超时（${timeout}ms）被终止`));
      }, timeout);

      const onAbort = () => {
        child.kill("SIGKILL");
        reject(new ToolError("命令被中断"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        reject(new ToolError(`无法启动命令: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        let body = out.slice(0, MAX_OUTPUT);
        if (truncated) body += `\n…（输出超过 ${MAX_OUTPUT} 字符已截断）`;
        resolve(`[exit ${code ?? "?"}]\n${body || "(无输出)"}`);
      });
    });
  },
};
