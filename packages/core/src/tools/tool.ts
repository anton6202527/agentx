/**
 * 工具接口 —— core 内部工具的统一形态。
 *
 * 一个工具 = ToolDefinition（喂给模型的 schema）+ 执行逻辑 + 元数据（只读？规则键？）。
 * 元数据让权限引擎无需硬编码工具名即可决策。
 */

import type { ToolDefinition } from "../types.js";

export interface ToolContext {
  /** 工作目录（所有相对路径的根，也是沙箱边界） */
  cwd: string;
  signal: AbortSignal;
}

export interface Tool {
  readonly def: ToolDefinition;
  /** 是否只读（无副作用）—— 权限引擎据此自动放行 */
  readonly readOnly: boolean;
  /** 从入参生成人类可读的动作摘要（UI 展示 + 权限规则匹配） */
  ruleKey(input: Record<string, unknown>): string;
  /** 执行，返回给模型的文本结果。抛异常 = 工具错误（上层包成 is_error 回传） */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolError extends Error {}

/** 把 { name → Tool } 注册进一个可查询的集合 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.def.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  readOnlyNames(): string[] {
    return [...this.tools.values()].filter((t) => t.readOnly).map((t) => t.def.name);
  }
}
