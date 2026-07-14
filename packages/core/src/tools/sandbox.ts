/**
 * OS 级命令沙箱（第一阶段：macOS Seatbelt / sandbox-exec）。
 *
 * 与权限系统正交、纵深防御：权限门管「模型被允许发起什么」，沙箱管「进程真正能碰什么」——
 * 即使 prompt 注入骗过模型，进程也写不出工作区、连不出网。对齐 Codex 的
 * SandboxPolicy 思路（read-only / workspace-write / full）。
 *
 * 策略（借鉴实用可用性，避免误伤良性命令）：以 `(allow default)` 打底，再收紧两件事——
 * 只允许写「工作区 + 临时目录 + /dev」，默认禁止出网。生成 SBPL 交给 `sandbox-exec -p`。
 * 非 macOS 平台返回 null（调用方裸跑）；后续阶段再补 Linux bubblewrap/Landlock。
 */

import * as os from "node:os";

export type SandboxPolicy = "none" | "read-only" | "workspace-write";

export interface SandboxSpec {
  policy: SandboxPolicy;
  /** 工作区根（workspace-write 下唯一默认可写的项目目录）。 */
  cwd: string;
  /** 追加可写根（如项目外的构建目录）。 */
  writableRoots?: readonly string[];
  /** 是否允许出网；workspace-write/read-only 默认 false。 */
  network?: boolean;
}

export interface WrappedCommand {
  file: string;
  args: string[];
}

/** 解析生效策略：显式优先，否则读环境变量 AGENTX_BASH_SANDBOX，默认 none。 */
export function resolveSandboxPolicy(
  explicit: SandboxPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SandboxPolicy {
  if (explicit && explicit !== "none") return explicit;
  const fromEnv = (env["AGENTX_BASH_SANDBOX"] ?? "").trim();
  if (fromEnv === "read-only" || fromEnv === "workspace-write" || fromEnv === "none") return fromEnv;
  return explicit ?? "none";
}

/**
 * 若当前平台/策略支持沙箱，返回把命令包起来的 argv；否则返回 null（裸跑）。
 * platform 可注入以便测试。
 */
export function wrapWithSandbox(
  command: string,
  spec: SandboxSpec,
  platform: NodeJS.Platform = process.platform,
): WrappedCommand | null {
  if (spec.policy === "none") return null;
  if (platform !== "darwin") return null; // 第一阶段仅 macOS
  const profile = buildSeatbeltProfile(spec);
  return { file: "sandbox-exec", args: ["-p", profile, "/bin/bash", "-c", command] };
}

/** 生成 Seatbelt SBPL profile 文本。 */
export function buildSeatbeltProfile(spec: SandboxSpec): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const roots =
    spec.policy === "workspace-write"
      ? dedupe([
          spec.cwd,
          ...(spec.writableRoots ?? []),
          os.tmpdir(),
          "/tmp",
          "/private/tmp",
          "/private/var/folders",
          "/dev",
        ])
      : ["/dev"]; // read-only：仅放行 /dev（/dev/null、/dev/stdout 等）
  for (const root of roots) lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  if (!spec.network) lines.push("(deny network*)");
  return lines.join("\n") + "\n";
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.filter((s) => s && s.length > 0))];
}

/** SBPL 字符串字面量转义。 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
