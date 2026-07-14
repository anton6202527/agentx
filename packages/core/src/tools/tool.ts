/**
 * 工具接口 —— core 内部工具的统一形态。
 *
 * 一个工具 = ToolDefinition（喂给模型的 schema）+ 执行逻辑 + 元数据（只读？规则键？）。
 * 元数据让权限引擎无需硬编码工具名即可决策。
 */

import type { ToolDefinition, Usage } from "../types.js";

export interface ToolContext {
  /** 工作目录（所有相对路径的根，也是沙箱边界） */
  cwd: string;
  signal: AbortSignal;
  /** OS 级命令沙箱策略（bash 工具据此包一层 sandbox-exec）；缺省 none / 读环境变量。 */
  sandbox?: "none" | "read-only" | "workspace-write";
  /**
   * 长任务进度上报通道（可选）。工具执行中调用它，事件会被 Agent 包成
   * tool_progress 实时转发给订阅者 —— 子 agent（task 工具）靠它回流内部事件流。
   * payload 形状由工具自定义，Agent 原样透传。
   */
  emit?: (progress: unknown) => void;
  /**
   * 工具内部产生的模型用量计入父 Agent。task 工具用它汇总子 agent 用量，
   * 避免会话快照与实际账单分叉。
   */
  addUsage?: (usage: Usage) => void;
}

export interface Tool {
  readonly def: ToolDefinition;
  /** 是否只读（无副作用）—— 权限引擎据此自动放行；也是并行执行的默认资格线 */
  readonly readOnly: boolean;
  /** 是否属于"文件编辑类"（write/edit）—— acceptEdits 权限模式据此自动放行 */
  readonly mutatesFiles?: boolean;
  /** 从入参生成人类可读的动作摘要（UI 展示 + 权限规则匹配） */
  ruleKey(input: Record<string, unknown>): string;
  /**
   * 本次调用是否可与其他调用并发（按入参判定，对齐 Claude Code 的
   * isConcurrencySafe）。缺省回落到 readOnly；有内部状态的只读工具应显式返回 false。
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
  /**
   * 把动作摘要拆成独立匹配单元（权限规则用）。bash 用它把复合命令按
   * && / || / ; / | 拆开 —— allow 需每个子命令都命中，deny 任一命中即拒。
   * 缺省 [ruleKey]。
   */
  ruleParts?(input: Record<string, unknown>): string[];
  /**
   * ruleParts 是否完整描述了命令的可执行单元。false 表示遇到复杂 shell 语法等
   * 无法可靠分析的情况；权限引擎会保守处理细粒度规则。
   */
  rulePartsComplete?(input: Record<string, unknown>): boolean;
  /**
   * 为另一个 Agent 创建独立工具实例。有闭包状态的工具必须实现；无状态工具可省略。
   */
  fork?(): Tool;
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

  editNames(): string[] {
    return [...this.tools.values()].filter((t) => t.mutatesFiles).map((t) => t.def.name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 为一个新 Agent 创建独立 registry；有状态工具通过 fork() 隔离闭包状态。 */
  clone(): ToolRegistry {
    return this.subset(this.names());
  }

  /** 生成指定工具子集；有 fork() 的有状态工具会得到独立实例。 */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) {
      const t = this.tools.get(name);
      if (t) sub.register(t.fork?.() ?? t);
    }
    return sub;
  }
}
