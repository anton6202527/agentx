/** JavaScript 任务：node 直接可跑，零依赖。 */
import type { EvalTask } from "../task.js";

export const JS_TASKS: EvalTask[] = [
  {
    id: "implement-add",
    title: "实现一个求和函数使测试通过",
    lang: "js",
    kind: "implement",
    prompt:
      "文件 math.mjs 里的 add(a, b) 还没实现。请把它实现为返回两数之和。改完后 `node verify.mjs` 应当通过。",
    files: {
      "math.mjs": "export function add(a, b) {\n  // TODO: 实现\n}\n",
      "verify.mjs":
        "import { add } from './math.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(add(2, 3), 5);\n" +
        "assert.equal(add(-1, 1), 0);\n" +
        "assert.equal(add(0, 0), 0);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: {
      "math.mjs": "export function add(a, b) {\n  return a + b;\n}\n",
    },
  },
  {
    id: "fix-off-by-one",
    title: "修复一个 off-by-one 缺陷",
    lang: "js",
    kind: "fix",
    prompt:
      "sum.mjs 里的 sumTo(n) 应返回 1..n 的和，但结果偏小。请修复它，使 `node verify.mjs` 通过。",
    files: {
      "sum.mjs":
        "export function sumTo(n) {\n" +
        "  let s = 0;\n" +
        "  for (let i = 1; i < n; i++) s += i;\n" +
        "  return s;\n" +
        "}\n",
      "verify.mjs":
        "import { sumTo } from './sum.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(sumTo(1), 1);\n" +
        "assert.equal(sumTo(5), 15);\n" +
        "assert.equal(sumTo(10), 55);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: {
      "sum.mjs":
        "export function sumTo(n) {\n" +
        "  let s = 0;\n" +
        "  for (let i = 1; i <= n; i++) s += i;\n" +
        "  return s;\n" +
        "}\n",
    },
  },
  {
    id: "multi-file-wire",
    title: "跨两个文件接线一个导出",
    lang: "js",
    kind: "refactor",
    prompt:
      "index.mjs 需要从 ./slug.mjs 导入并重新导出一个 slugify(s) 函数，但 slug.mjs 还是空的。" +
      "请在 slug.mjs 实现 slugify（小写、非字母数字转连字符、去掉首尾连字符），并在 index.mjs 里导出它，" +
      "使 `node verify.mjs` 通过。",
    files: {
      "slug.mjs": "// 在这里实现并导出 slugify\n",
      "index.mjs": "// 从 ./slug.mjs 重新导出 slugify\n",
      "verify.mjs":
        "import { slugify } from './index.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(slugify('Hello World'), 'hello-world');\n" +
        "assert.equal(slugify('  A_B c '), 'a-b-c');\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: {
      "slug.mjs":
        "export function slugify(s) {\n" +
        "  return s\n" +
        "    .toLowerCase()\n" +
        "    .replace(/[^a-z0-9]+/g, '-')\n" +
        "    .replace(/^-+|-+$/g, '');\n" +
        "}\n",
      "index.mjs": "export { slugify } from './slug.mjs';\n",
    },
  },
  {
    id: "js-debug-sort",
    title: "调试：中位数结果错误（默认字典序排序陷阱）",
    lang: "js",
    kind: "debug",
    prompt:
      "stats.mjs 的 median(xs) 在某些输入下返回错误结果。先运行 `node verify.mjs` 复现失败，" +
      "再定位并修复 stats.mjs 中的缺陷（不要改 verify.mjs），使校验通过。",
    files: {
      "stats.mjs":
        "export function median(xs) {\n" +
        "  const s = [...xs].sort();\n" +
        "  const mid = Math.floor(s.length / 2);\n" +
        "  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;\n" +
        "}\n",
      "verify.mjs":
        "import { median } from './stats.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(median([1, 2, 3]), 2);\n" +
        "assert.equal(median([10, 2, 33]), 10);\n" +
        "assert.equal(median([1, 2, 3, 4]), 2.5);\n" +
        "assert.equal(median([100, 20, 3, 4000]), 60);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: {
      "stats.mjs":
        "export function median(xs) {\n" +
        "  const s = [...xs].sort((a, b) => a - b);\n" +
        "  const mid = Math.floor(s.length / 2);\n" +
        "  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;\n" +
        "}\n",
    },
  },
  {
    id: "js-refactor-extract",
    title: "重构：把重复的 formatPrice 抽取到共享模块",
    lang: "js",
    kind: "refactor",
    prompt:
      "cart.mjs 和 invoice.mjs 各自复制了一份一模一样的 formatPrice。请把它抽取到新文件 util.mjs " +
      "并导出，两个文件改为从 './util.mjs' 导入（自身不再定义 formatPrice），对外行为保持不变。" +
      "改完 `node verify.mjs` 应当通过（校验会检查行为与源码结构）。",
    files: {
      "cart.mjs":
        "function formatPrice(cents) {\n" +
        "  return '$' + (cents / 100).toFixed(2);\n" +
        "}\n" +
        "export function cartTotal(items) {\n" +
        "  const cents = items.reduce((s, it) => s + it.cents, 0);\n" +
        "  return formatPrice(cents);\n" +
        "}\n",
      "invoice.mjs":
        "function formatPrice(cents) {\n" +
        "  return '$' + (cents / 100).toFixed(2);\n" +
        "}\n" +
        "export function invoiceLine(name, cents) {\n" +
        "  return name + ': ' + formatPrice(cents);\n" +
        "}\n",
      "verify.mjs":
        "import assert from 'node:assert/strict';\n" +
        "import { readFileSync } from 'node:fs';\n" +
        "const { formatPrice } = await import('./util.mjs');\n" +
        "const { cartTotal } = await import('./cart.mjs');\n" +
        "const { invoiceLine } = await import('./invoice.mjs');\n" +
        "assert.equal(formatPrice(1250), '$12.50');\n" +
        "assert.equal(cartTotal([{ cents: 100 }, { cents: 250 }]), '$3.50');\n" +
        "assert.equal(invoiceLine('pen', 99), 'pen: $0.99');\n" +
        "for (const f of ['cart.mjs', 'invoice.mjs']) {\n" +
        "  const src = readFileSync(f, 'utf8');\n" +
        "  assert.ok(src.includes('./util.mjs'), f + ' 应从 ./util.mjs 导入');\n" +
        "  assert.ok(!/function\\s+formatPrice/.test(src), f + ' 不应再自己定义 formatPrice');\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: {
      "util.mjs":
        "export function formatPrice(cents) {\n" +
        "  return '$' + (cents / 100).toFixed(2);\n" +
        "}\n",
      "cart.mjs":
        "import { formatPrice } from './util.mjs';\n" +
        "export function cartTotal(items) {\n" +
        "  const cents = items.reduce((s, it) => s + it.cents, 0);\n" +
        "  return formatPrice(cents);\n" +
        "}\n",
      "invoice.mjs":
        "import { formatPrice } from './util.mjs';\n" +
        "export function invoiceLine(name, cents) {\n" +
        "  return name + ': ' + formatPrice(cents);\n" +
        "}\n",
    },
  },
];
