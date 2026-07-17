/** 汇总与打印评测报告（终端表格 + 可选 JSON）。 */
import type { TaskResult } from "./runner.js";

export interface Summary {
  model: string;
  /** 运行时设置（A/B 对比时应逐项一致才可比）。 */
  settings?: { repomap?: boolean };
  /** 实际运行的任务数（不含 skipped）。 */
  total: number;
  passed: number;
  /** 因缺工具链跳过的任务数。 */
  skipped: number;
  passRate: number;
  avgTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  editCalls: number;
  editErrors: number;
  /** 编辑失败率 = editErrors / editCalls（无编辑则 0）。 */
  editFailureRate: number;
  totalWallMs: number;
  results: TaskResult[];
}

export function summarize(
  model: string,
  results: TaskResult[],
  settings?: Summary["settings"],
): Summary {
  const ran = results.filter((r) => !r.skipped);
  const skipped = results.length - ran.length;
  const passed = ran.filter((r) => r.passed).length;
  const editCalls = ran.reduce((s, r) => s + r.editCalls, 0);
  const editErrors = ran.reduce((s, r) => s + r.editErrors, 0);
  return {
    model,
    ...(settings ? { settings } : {}),
    total: ran.length,
    passed,
    skipped,
    passRate: ran.length ? passed / ran.length : 0,
    avgTurns: ran.length ? ran.reduce((s, r) => s + r.turns, 0) / ran.length : 0,
    totalInputTokens: ran.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: ran.reduce((s, r) => s + r.outputTokens, 0),
    editCalls,
    editErrors,
    editFailureRate: editCalls ? editErrors / editCalls : 0,
    totalWallMs: ran.reduce((s, r) => s + r.wallMs, 0),
    results,
  };
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** 渲染成人可读表格（纯字符串，便于测试与重定向）。 */
export function formatReport(sum: Summary): string {
  const lines: string[] = [];
  lines.push(`模型: ${sum.model}${sum.settings?.repomap ? " (repomap)" : ""}`);
  lines.push("");
  lines.push(
    [
      pad("任务", 20),
      pad("通过", 6),
      pad("轮数", 6),
      pad("工具", 6),
      pad("编辑失败", 8),
      pad("in/out tok", 14),
      "ms",
    ].join(" "),
  );
  lines.push("-".repeat(72));
  for (const r of sum.results) {
    lines.push(
      [
        pad(r.id, 20),
        pad(r.skipped ? "↷" : r.passed ? "✓" : "✗", 6),
        pad(String(r.turns), 6),
        pad(String(r.toolCalls), 6),
        pad(`${r.editErrors}/${r.editCalls}`, 8),
        pad(`${r.inputTokens}/${r.outputTokens}`, 14),
        String(r.wallMs),
      ].join(" "),
    );
    if (r.error) lines.push(`  ! ${r.error}`);
  }
  lines.push("-".repeat(72));
  lines.push(
    `通过率 ${sum.passed}/${sum.total} (${(sum.passRate * 100).toFixed(0)}%)` +
      (sum.skipped ? ` · 跳过 ${sum.skipped}` : "") +
      ` · ` +
      `平均轮数 ${sum.avgTurns.toFixed(1)} · ` +
      `编辑失败率 ${(sum.editFailureRate * 100).toFixed(0)}% (${sum.editErrors}/${sum.editCalls}) · ` +
      `token in ${sum.totalInputTokens} / out ${sum.totalOutputTokens} · ` +
      `${(sum.totalWallMs / 1000).toFixed(1)}s`,
  );
  return lines.join("\n");
}
