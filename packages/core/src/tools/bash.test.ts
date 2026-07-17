/**
 * bash 前台执行的输出契约测试：
 * - 超时不是「无结果」：命令挂住前打印的内容必须如实回传（回归：旧实现只丢一句超时）；
 * - 超长输出保留头和尾：构建/测试的失败摘要几乎总在结尾，只留头部等于丢了最有用那段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashTool } from "./bash.js";
import type { ToolContext } from "./tool.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal };
}

test("bash: 超时返回终止前已捕获的输出（带 [timeout] 标记），而非丢弃", async () => {
  // 先写一大块（>管道缓冲，强制刷出）再挂 5s；1.5s 超时被 SIGKILL。
  // 用 node 保证跨平台可用，不依赖 python/coreutils。
  const command = `node -e "process.stdout.write('MARKER '.repeat(4000)); setTimeout(()=>{}, 5000)"`;
  const out = await bashTool.run({ command, timeout_ms: 1500 }, ctx());
  assert.match(out, /\[timeout 1500ms\]/);
  assert.match(out, /MARKER/); // 终止前的输出被保留下来
});

test("bash: 超长输出保留头与尾，中段截断（尾部摘要不丢）", async () => {
  const command = `node -e "process.stdout.write('HEADMARK\\n' + 'x'.repeat(60000) + '\\nTAILMARK\\n')"`;
  const out = await bashTool.run({ command }, ctx());
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /HEADMARK/); // 头部保留
  assert.match(out, /TAILMARK/); // 尾部保留（回归：旧实现只留头部会丢掉这段）
  assert.match(out, /中段已截断/); // 明确的截断提示
});

test("bash: 空输出命令回报 (无输出) 与退出码", async () => {
  const out = await bashTool.run({ command: "true" }, ctx());
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /无输出/);
});
