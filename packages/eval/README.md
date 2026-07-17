# @anicode/eval

编辑准确率评测 harness。用**真实的 agent loop**（core 的 Agent + 默认工具 + 权限
bypass）跑一组自带校验的编辑任务，量化：

- **通过率**（校验命令退出码 0 的任务占比；缺工具链跳过的任务不进分母）
- **平均轮数**（模型 loop 轮数）
- **token**（in/out 累计）
- **编辑失败率**（编辑类工具返回 isError 的次数 / 编辑类工具调用次数）

核心用途：**证明改动是否真的变好**。改了系统提示词 / 工具 / 编辑策略后再跑一遍，
比对同一模型下的这几项指标——因为「同一模型换 harness，分数摆动 15–20 分」，
没有 eval 就无法判断 scaffolding 改动的好坏。

## 任务矩阵

16 个内置任务：**4 语言 × 4 类型**。

| | JS (node) | TS (node strip-types) | Python (python3) | Go (go run) |
|---|---|---|---|---|
| implement | implement-add | ts-implement-lru | py-implement-slugify | go-implement-reverse / go-wire-titlecase |
| fix | fix-off-by-one | ts-fix-first-defined | py-fix-mutable-default | go-fix-nil-map |
| debug | js-debug-sort | ts-debug-chunk | py-debug-window-sum | go-debug-truncate |
| refactor | multi-file-wire / js-refactor-extract | — | py-refactor-split | — |

- **debug 类**要求先运行校验复现失败再定位（驱动 bash→read→edit 完整工具链）。
- **refactor 类**校验既查行为也查源码结构（确实抽走了、确实改成导入了）。
- 缺 `python3`/`go` 时对应任务**跳过**而非失败（`requires` 声明 + PATH 探测）。
- **防作弊**：跑校验前把校验脚本从种子恢复，agent 改 verify 文件不算通过。

## 跑真实评测

```bash
npm run eval -- --model anthropic/claude-opus-4-8
npm run eval -- --model openai/gpt-5.5 --lang go,py --kind debug --json out.json
npm run eval -- --model anthropic/claude-opus-4-8 --repomap --json with-map.json  # A/B repomap
npm run eval -- --model anthropic/claude-opus-4-8 --baseline baseline.json        # 守回归
```

- `--model <provider/model>` 走 core 的 provider registry（需对应凭证）。
- `--tasks id1,id2` / `--lang js,go` / `--kind fix,debug` 按 id/语言/类型筛选。
- `--max-turns N` 单任务轮数上限（默认 30）。
- `--repomap` 给 Agent 开 repo map，报告标注 `(repomap)`——用于 A/B scaffolding。
- `--json <file>` 导出结构化结果供 A/B 对比。
- `--baseline <file>` 与历史 JSON 比通过率，跌超 `--tolerance`（默认 0.06）退出码 1。
- 无基线时全通过退出 0，否则 1（便于接门禁）。

## CI 集成

- **PR（离线）**：`npm test` 里的自检不依赖模型，随 CI 每次跑——包括「编辑→校验→指标」
  管线回归、防作弊校验、以及**任务自检**（下节）。
- **Nightly（真模型）**：`.github/workflows/eval-nightly.yml` 每晚跑全矩阵，产出 JSON
  工件；若仓库提交了 `packages/eval/baseline.json` 则自动比基线，回归即红。
  没配 `ANTHROPIC_API_KEY` 时静默跳过。更新基线：把 nightly 工件里的 JSON 落到
  `packages/eval/baseline.json` 提交即可。

## 加任务

往 `src/tasks/{js,ts,python,go}.ts` 对应数组加条目。每个任务必须带 `solution` 参考解，
自检（`tasks.selftest.test.ts`）会自动守两条不变量：

1. **种子原样跑校验必须失败**——任务不能「白给」；
2. **应用参考解后校验必须通过**——任务可解、校验正确。

校验脚本只用对应语言标准库（node / python3 / go），零外部依赖离线可跑。

## 长期锚点

自建任务守**相对回归**，外部基准定**绝对水平**。后续可把
[Terminal-Bench](https://www.tbench.ai/)（Docker 隔离、16 类 89 任务）作为季度性
对外可比分数——两者互补，自建矩阵不追求覆盖它。
