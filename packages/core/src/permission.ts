/**
 * 权限系统 —— UI 无关。
 *
 * 决策链（第一个命中即返回）：
 *   1. mode=bypass          → 全部 allow（危险，仅限沙箱/CI 明确授权）
 *   2. 只读工具             → allow（Read/Grep/Glob 等无副作用）
 *   3. allowRules 命中      → allow（用户/项目预授权规则）
 *   4. mode=auto            → allow（写/执行也自动放行，但仍受 allowRules 之外的护栏）
 *   5. 交给 confirm 回调    → 由前端（TUI/App/CI）决定
 *
 * confirm 回调是 core 与前端的唯一耦合点：core 不知道谁在确认，
 * 前端返回 allow / deny / allow-and-remember。
 */

export type PermissionMode = "default" | "auto" | "bypass";

export interface PermissionDecision {
  behavior: "allow" | "deny";
  /** allow 时可改写入参（如收窄 bash 命令）；deny 时无意义 */
  updatedInput?: Record<string, unknown>;
  /** deny 时给模型看的原因，让它自行改路 */
  message?: string;
  /** 记住本次决定：后续同 (tool,ruleKey) 直接放行 */
  remember?: boolean;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** 工具自报的"人类可读的动作摘要"，用于 UI 展示与规则匹配 */
  ruleKey: string;
  /** 触发本次授权的工具调用 id —— 供前端把授权提示关联到对应的 tool_start 行 */
  toolCallId: string;
  signal: AbortSignal;
}

export type ConfirmFn = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface PermissionConfig {
  mode?: PermissionMode;
  /** 预授权规则，形如 "Bash", "Bash(git *)", "Write" —— 命中即放行 */
  allowRules?: string[];
  /** 只读工具名集合（默认 Read/Grep/Glob/List） */
  readOnlyTools?: string[];
  confirm?: ConfirmFn;
}

const DEFAULT_READONLY = ["read", "grep", "glob", "list"];

export class PermissionEngine {
  private mode: PermissionMode;
  private readOnly: Set<string>;
  private allowRules: string[];
  private remembered = new Set<string>();
  private confirm?: ConfirmFn;

  constructor(cfg: PermissionConfig = {}) {
    this.mode = cfg.mode ?? "default";
    this.readOnly = new Set((cfg.readOnlyTools ?? DEFAULT_READONLY).map((s) => s.toLowerCase()));
    this.allowRules = cfg.allowRules ?? [];
    if (cfg.confirm) this.confirm = cfg.confirm;
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    if (this.mode === "bypass") return { behavior: "allow" };
    if (this.readOnly.has(req.toolName.toLowerCase())) return { behavior: "allow" };

    const memoKey = `${req.toolName}::${req.ruleKey}`;
    if (this.remembered.has(memoKey)) return { behavior: "allow" };
    if (this.matchesRule(req.toolName, req.ruleKey)) return { behavior: "allow" };

    if (this.mode === "auto") return { behavior: "allow" };

    if (!this.confirm) {
      return {
        behavior: "deny",
        message: `工具 ${req.toolName} 需要授权，但未配置确认回调（非交互环境）`,
      };
    }
    const decision = await this.confirm(req);
    if (decision.behavior === "allow" && decision.remember) {
      this.remembered.add(memoKey);
    }
    return decision;
  }

  /** 规则匹配：精确工具名，或 "Tool(glob)" 形式对 ruleKey 做 glob */
  private matchesRule(toolName: string, ruleKey: string): boolean {
    for (const rule of this.allowRules) {
      const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
      if (!m) continue;
      const [, ruleTool, pattern] = m;
      if (ruleTool!.toLowerCase() !== toolName.toLowerCase()) continue;
      if (pattern === undefined) return true; // 裸工具名，放行全部
      if (globMatch(pattern, ruleKey)) return true;
    }
    return false;
  }
}

/** 极简 glob：* 匹配任意字符（含空格），其余字面匹配 */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}
