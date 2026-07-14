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
import { resolveSandboxPolicy, wrapWithSandbox } from "./sandbox.js";
import * as path from "node:path";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000; // 截断超长输出，保护上下文

/**
 * 把复合命令按顶层 shell 操作符（&& || ; | & 换行）拆成子命令（尊重引号）。
 * 权限规则据此逐段匹配："git status && rm -rf /" 绝不该命中 "Bash(git *)"。
 * 保守解析：不理解子 shell/重定向的语义，只做顶层切分 —— 拆不细则整段匹配，
 * 宁可多问一次也不放行。
 */
export interface ShellCommandAnalysis {
  parts: string[];
  /** false = 遇到重定向/命令替换/分组等无法由轻量扫描器可靠展开的语法 */
  complete: boolean;
}

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const rawParts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let complete = true;
  const flush = () => {
    const part = cur.trim();
    if (part) rawParts.push(part);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\") {
        if (i + 1 < command.length) cur += command[++i]!;
        else complete = false;
        continue;
      }
      if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) {
        complete = false;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      cur += c;
      if (i + 1 < command.length) cur += command[++i]!;
      else complete = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // 这些语法可隐藏额外可执行命令或产生写入；保留原文但标记分析不完整。
    if (
      c === "`" ||
      c === ">" ||
      c === "<" ||
      c === "(" ||
      c === ")" ||
      c === "{" ||
      c === "}" ||
      (c === "$" && command[i + 1] === "(") ||
      (c === "#" && (i === 0 || /\s/.test(command[i - 1]!)))
    ) {
      complete = false;
      cur += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      flush();
      if (c === "\r" && command[i + 1] === "\n") i++;
      continue;
    }
    cur += c;
  }
  if (quote) complete = false;
  flush();
  const parts: string[] = [];
  for (const raw of rawParts) {
    const normalized = normalizeSimpleCommand(raw);
    if (normalized.command) parts.push(normalized.command);
    if (!normalized.complete) complete = false;
  }
  return { parts, complete };
}

export function splitShellCommand(command: string): string[] {
  return analyzeShellCommand(command).parts;
}

const SHELL_CONTROL_WORDS = new Set([
  "!", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "select", "function", "coproc", "time",
]);
const COMMAND_WRAPPERS = new Set([
  "env", "command", "builtin", "exec", "eval", "source", ".", "sudo", "doas", "nohup",
  "xargs", "parallel", "nice", "timeout",
]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/**
 * 把一个已切分的简单命令词法规范化：去掉不改变词义的引号/转义、合并空白，
 * 并把绝对/相对可执行路径归一成 basename。无法可靠展开的包装器与控制语法
 * 标为 incomplete，让权限引擎拒绝用细粒度 glob 自动放行。
 */
function normalizeSimpleCommand(raw: string): { command: string; complete: boolean } {
  const words: string[] = [];
  let word = "";
  let active = false;
  let quote: '"' | "'" | null = null;
  let complete = true;
  const pushWord = () => {
    if (!active) return;
    words.push(word);
    word = "";
    active = false;
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\") {
        if (i + 1 >= raw.length) {
          complete = false;
        } else {
          const next = raw[++i]!;
          // bash 双引号里反斜杠只转义 $ ` " \\ 与换行；其他字符前的
          // 反斜杠会原样保留，不能把 "g\\it" 错规范化成 "git"。
          if (next === "$" || next === "`" || next === '"' || next === "\\") word += next;
          else if (next !== "\n") word += `\\${next}`;
        }
      } else {
        if (c === "$" || c === "`") complete = false;
        word += c;
      }
      active = true;
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      active = true;
      continue;
    }
    if (c === "\\") {
      active = true;
      if (i + 1 < raw.length) word += raw[++i]!;
      else complete = false;
      continue;
    }
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[") complete = false;
    word += c;
    active = true;
  }
  if (quote) complete = false;
  pushWord();
  if (words.length === 0) return { command: "", complete };

  // 赋值前缀与 shell 控制字会改变真正的命令位置。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || SHELL_CONTROL_WORDS.has(words[0]!)) {
    complete = false;
  }
  const originalExecutable = words[0]!;
  const executable = path.basename(originalExecutable);
  words[0] = executable;
  // basename 规范化用于让 deny 捕获 /bin/rm；但带路径的可执行文件可能只是
  // 恶意同名程序，不能据此获得 Bash(git *) 一类细粒度 allow。
  if (originalExecutable !== executable) complete = false;
  if (COMMAND_WRAPPERS.has(executable)) complete = false;
  if (SHELL_INTERPRETERS.has(executable) && words.some((w) => w === "-c" || w === "--command")) {
    complete = false;
  }
  if (executable === "find" && words.some((w) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fls)/.test(w))) {
    complete = false;
  }
  // `git -c alias.x=!command x` 是一个任意命令入口，不能命中 Bash(git *) 自动放行。
  if (executable === "git" && words.some((w) => w === "-c" || w.startsWith("--config-env="))) {
    complete = false;
  }

  const command = words.map((w) =>
    w === "" || /[\s;&|<>]/.test(w) ? JSON.stringify(w) : w,
  ).join(" ");
  return { command, complete };
}

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
  ruleParts: (i) => analyzeShellCommand(String(i["command"] ?? "")).parts,
  rulePartsComplete: (i) => analyzeShellCommand(String(i["command"] ?? "")).complete,
  // shell 的实际副作用无法靠首词白名单可靠判断（重定向、find -delete、git 配置等）。
  // 真沙箱/完整 AST 分析落地前一律串行。
  isConcurrencySafe: () => false,
  run(input, ctx: ToolContext): Promise<string> {
    const command = String(input["command"] ?? "");
    if (!command) throw new ToolError("command 不能为空");
    if (ctx.signal.aborted) throw new ToolError("命令被中断");
    const requestedTimeout = Number(input["timeout_ms"] ?? DEFAULT_TIMEOUT_MS);
    const timeout = Number.isFinite(requestedTimeout)
      ? Math.max(1000, requestedTimeout)
      : DEFAULT_TIMEOUT_MS;

    // OS 级沙箱（macOS 第一阶段）：可写限工作区 + 临时目录，默认断网。裸跑为 fallback。
    const policy = resolveSandboxPolicy(ctx.sandbox);
    const wrapped = wrapWithSandbox(command, { policy, cwd: ctx.cwd });
    const spawnFile = wrapped ? wrapped.file : "/bin/bash";
    const spawnArgs = wrapped ? wrapped.args : ["-c", command];

    return new Promise((resolve, reject) => {
      const child = spawn(spawnFile, spawnArgs, {
        cwd: ctx.cwd,
        env: sanitizedShellEnv(),
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

/** 避免 BASH_ENV / 导出的 shell function 在命令正文前隐式执行。 */
function sanitizedShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "BASH_ENV" || key === "ENV" || key.startsWith("BASH_FUNC_")) continue;
    env[key] = value;
  }
  return env;
}
