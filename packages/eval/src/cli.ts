/**
 * 评测 CLI。
 *
 *   npm run eval -- --model anthropic/claude-opus-4-8 [--tasks id1,id2] [--lang go,py]
 *                   [--kind debug] [--max-turns 30] [--repomap] [--json out.json]
 *                   [--baseline prev.json] [--tolerance 0.06]
 *
 * --model 走 core 的 provider registry（需对应凭证）。跑完打印表格，并可导出 JSON 供
 * A/B 对比（改了 prompt/工具后再跑一遍，比对通过率/轮数/token/编辑失败率）。
 * --baseline 与历史 JSON 对比：通过率下降超过 --tolerance（默认 0.06，约容忍
 * 16 任务里 1 个偶发失败）则退出码 1——nightly 用它守回归。
 * 缺工具链（python3/go）的任务自动跳过，不计入通过率分母。
 */
import { promises as fs } from "node:fs";
import { createProvider } from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { missingRequirements, runTask, skippedResult } from "./runner.js";
import { formatReport, summarize, type Summary } from "./report.js";

interface Args {
  model?: string | undefined;
  tasks?: string[] | undefined;
  lang?: string[] | undefined;
  kind?: string[] | undefined;
  maxTurns?: number | undefined;
  json?: string | undefined;
  repomap?: boolean | undefined;
  baseline?: string | undefined;
  tolerance?: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--tasks") args.tasks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--lang") args.lang = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--kind") args.kind = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--repomap") args.repomap = true;
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.model = undefined;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

/** 与基线比较：通过率下降超容忍度则返回失败说明，否则 null。 */
export function compareToBaseline(
  current: Summary,
  baseline: Summary,
  tolerance: number,
): string | null {
  const drop = baseline.passRate - current.passRate;
  if (drop > tolerance) {
    return (
      `回归：通过率 ${(current.passRate * 100).toFixed(0)}% 低于基线 ` +
      `${(baseline.passRate * 100).toFixed(0)}%（容忍 ${(tolerance * 100).toFixed(0)} 个百分点）`
    );
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error(
      "用法: npm run eval -- --model <provider/model> [--tasks id1,id2] [--lang js,go] " +
        "[--kind fix,debug] [--max-turns N] [--repomap] [--json out.json] " +
        "[--baseline prev.json] [--tolerance 0.06]",
    );
    console.error(`可用任务: ${BUILTIN_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  const created = createProvider(args.model);
  let tasks = BUILTIN_TASKS;
  if (args.tasks) tasks = tasks.filter((t) => args.tasks!.includes(t.id));
  if (args.lang) tasks = tasks.filter((t) => args.lang!.includes(t.lang));
  if (args.kind) tasks = tasks.filter((t) => args.kind!.includes(t.kind));
  if (tasks.length === 0) {
    console.error("没有匹配的任务");
    process.exit(2);
  }

  console.error(`跑 ${tasks.length} 个任务 · 模型 ${args.model}…\n`);
  const results = [];
  for (const task of tasks) {
    process.stderr.write(`  → ${task.id} … `);
    const missing = missingRequirements(task);
    if (missing.length > 0) {
      console.error(`↷ 跳过（缺 ${missing.join(", ")}）`);
      results.push(skippedResult(task, missing));
      continue;
    }
    const r = await runTask(task, {
      provider: created.provider,
      model: created.model,
      ...(created.modelInfo ? { modelInfo: created.modelInfo } : {}),
      ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
      ...(args.repomap ? { repomap: true } : {}),
    });
    console.error(r.passed ? "✓" : `✗${r.error ? " (" + r.error + ")" : ""}`);
    results.push(r);
  }

  const sum = summarize(args.model, results, args.repomap ? { repomap: true } : undefined);
  console.log("\n" + formatReport(sum));
  if (args.json) {
    await fs.writeFile(args.json, JSON.stringify(sum, null, 2), "utf8");
    console.error(`\nJSON 已写入 ${args.json}`);
  }

  if (args.baseline) {
    let baseline: Summary | undefined;
    try {
      baseline = JSON.parse(await fs.readFile(args.baseline, "utf8")) as Summary;
    } catch {
      console.error(`基线 ${args.baseline} 不存在或不可读，跳过比较`);
    }
    if (baseline) {
      const regression = compareToBaseline(sum, baseline, args.tolerance ?? 0.06);
      if (regression) {
        console.error(`\n${regression}`);
        process.exit(1);
      }
      console.error(
        `\n基线比较通过（基线 ${(baseline.passRate * 100).toFixed(0)}% → ` +
          `当前 ${(sum.passRate * 100).toFixed(0)}%）`,
      );
      process.exit(0);
    }
  }

  // 无基线时：全通过退出 0，否则 1——便于把 eval 接进门禁/看板。
  process.exit(sum.passed === sum.total ? 0 : 1);
}

// 仅作为 CLI 入口执行时才跑 main（便于测试导入 compareToBaseline）。
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
