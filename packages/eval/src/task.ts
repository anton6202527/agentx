/**
 * 评测任务模型。
 *
 * 一个任务 = 种子文件 + 面向 agent 的指令 + 一条离线可跑的校验命令。
 * 设计成零依赖、可离线验证：校验脚本随种子文件一起写入工作目录，用对应语言的
 * 工具链跑，退出码 0 视为通过。缺工具链（python3/go）的任务会被跳过而非失败。
 *
 * 每个任务应满足两条自检不变量（tasks.selftest.test.ts 离线守护）：
 *   1. 种子原样跑校验必须失败——任务不能「白给」；
 *   2. 应用 solution（参考解）后校验必须通过——任务可解且校验正确。
 */

export type TaskLang = "js" | "ts" | "py" | "go";
export type TaskKind = "implement" | "fix" | "debug" | "refactor";

export interface EvalTask {
  /** 稳定 id，用于筛选与报告。 */
  id: string;
  /** 一句话说明任务意图（报告里展示）。 */
  title: string;
  /** 任务语言（报告分组用）。 */
  lang: TaskLang;
  /** 任务类型：从零实现 / 定点修复 / 需先复现的调试 / 跨文件重构。 */
  kind: TaskKind;
  /** 面向 agent 的完整指令（作为一条 user 消息发送）。 */
  prompt: string;
  /** 初始化到工作目录的种子文件：相对路径 → 内容。 */
  files: Record<string, string>;
  /** 校验命令：在工作目录里执行，退出码 0 视为通过。 */
  verify: { cmd: string; args: string[] };
  /**
   * 跑校验前从种子恢复的文件（防 agent 篡改校验脚本作弊）。
   * 缺省恢复所有文件名以 `verify.` 开头的种子文件。
   */
  verifyFiles?: string[];
  /** 校验依赖的可执行文件（如 python3/go）；缺失时任务被跳过。node 不必声明。 */
  requires?: string[];
  /** 参考解：相对路径 → 内容。仅用于任务自检，绝不进 agent 上下文。 */
  solution?: Record<string, string>;
}

/** 认定为「文件编辑类」的工具名——用于统计编辑失败率。 */
export const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);

/** 任务默认要恢复的校验文件清单。 */
export function verifyFilesOf(task: EvalTask): string[] {
  return task.verifyFiles ?? Object.keys(task.files).filter((f) => f.startsWith("verify."));
}
