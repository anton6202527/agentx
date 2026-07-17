/**
 * TypeScript 任务：用 node 原生类型剥离跑 .mts（node >= 22.6，
 * `--experimental-strip-types` 在更高版本上已默认启用、仍接受该旗标），零外部依赖。
 */
import type { EvalTask } from "../task.js";

const NODE_TS = ["--experimental-strip-types"];

export const TS_TASKS: EvalTask[] = [
  {
    id: "ts-fix-first-defined",
    title: "修复 falsy 值被跳过的谓词缺陷",
    lang: "ts",
    kind: "fix",
    prompt:
      "opt.mts 的 firstDefined(xs) 应返回数组里第一个不为 undefined 的元素（0、'' 、false 都算有效值），" +
      "但现在它们被跳过了。请修复实现，使 `node --experimental-strip-types verify.mts` 通过。",
    files: {
      "opt.mts":
        "export function firstDefined<T>(xs: (T | undefined)[]): T | undefined {\n" +
        "  return xs.find((x) => x);\n" +
        "}\n",
      "verify.mts":
        "import { firstDefined } from './opt.mts';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(firstDefined([undefined, 0, 1]), 0);\n" +
        "assert.equal(firstDefined([undefined, '', 'a']), '');\n" +
        "assert.equal(firstDefined([false, true]), false);\n" +
        "assert.equal(firstDefined([undefined, undefined]), undefined);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: [...NODE_TS, "verify.mts"] },
    solution: {
      "opt.mts":
        "export function firstDefined<T>(xs: (T | undefined)[]): T | undefined {\n" +
        "  return xs.find((x) => x !== undefined);\n" +
        "}\n",
    },
  },
  {
    id: "ts-implement-lru",
    title: "实现一个带淘汰的 LRU 缓存类",
    lang: "ts",
    kind: "implement",
    prompt:
      "lru.mts 里的 LRUCache 类只有骨架。请实现 get/set：容量满时淘汰「最久未使用」的键，" +
      "get 命中也要刷新新鲜度。改完 `node --experimental-strip-types verify.mts` 应当通过。",
    files: {
      "lru.mts":
        "export class LRUCache<K, V> {\n" +
        "  readonly capacity: number;\n" +
        "  constructor(capacity: number) {\n" +
        "    this.capacity = capacity;\n" +
        "  }\n" +
        "  get(key: K): V | undefined {\n" +
        "    // TODO: 实现\n" +
        "    return undefined;\n" +
        "  }\n" +
        "  set(key: K, value: V): void {\n" +
        "    // TODO: 实现\n" +
        "  }\n" +
        "}\n",
      "verify.mts":
        "import { LRUCache } from './lru.mts';\n" +
        "import assert from 'node:assert/strict';\n" +
        "const c = new LRUCache<string, number>(2);\n" +
        "c.set('a', 1);\n" +
        "c.set('b', 2);\n" +
        "assert.equal(c.get('a'), 1); // 刷新 a 的新鲜度\n" +
        "c.set('c', 3); // 容量 2：应淘汰 b（最久未使用）\n" +
        "assert.equal(c.get('b'), undefined);\n" +
        "assert.equal(c.get('a'), 1);\n" +
        "assert.equal(c.get('c'), 3);\n" +
        "c.set('a', 9); // 覆盖已有键不应误淘汰\n" +
        "assert.equal(c.get('a'), 9);\n" +
        "assert.equal(c.get('c'), 3);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: [...NODE_TS, "verify.mts"] },
    solution: {
      "lru.mts":
        "export class LRUCache<K, V> {\n" +
        "  readonly capacity: number;\n" +
        "  private map = new Map<K, V>();\n" +
        "  constructor(capacity: number) {\n" +
        "    this.capacity = capacity;\n" +
        "  }\n" +
        "  get(key: K): V | undefined {\n" +
        "    if (!this.map.has(key)) return undefined;\n" +
        "    const v = this.map.get(key)!;\n" +
        "    this.map.delete(key);\n" +
        "    this.map.set(key, v);\n" +
        "    return v;\n" +
        "  }\n" +
        "  set(key: K, value: V): void {\n" +
        "    if (this.map.has(key)) this.map.delete(key);\n" +
        "    else if (this.map.size >= this.capacity) {\n" +
        "      const oldest = this.map.keys().next().value as K;\n" +
        "      this.map.delete(oldest);\n" +
        "    }\n" +
        "    this.map.set(key, value);\n" +
        "  }\n" +
        "}\n",
    },
  },
  {
    id: "ts-debug-chunk",
    title: "调试：分块函数丢掉了最后一个不满块",
    lang: "ts",
    kind: "debug",
    prompt:
      "chunk.mts 的 chunk(xs, size) 在某些输入下少返回数据。先运行 " +
      "`node --experimental-strip-types verify.mts` 复现失败，再修复 chunk.mts（不要改 verify.mts）。",
    files: {
      "chunk.mts":
        "export function chunk<T>(xs: T[], size: number): T[][] {\n" +
        "  const out: T[][] = [];\n" +
        "  for (let i = 0; i + size <= xs.length; i += size) {\n" +
        "    out.push(xs.slice(i, i + size));\n" +
        "  }\n" +
        "  return out;\n" +
        "}\n",
      "verify.mts":
        "import { chunk } from './chunk.mts';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);\n" +
        "assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n" +
        "assert.deepEqual(chunk([1], 3), [[1]]);\n" +
        "assert.deepEqual(chunk([], 2), []);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: [...NODE_TS, "verify.mts"] },
    solution: {
      "chunk.mts":
        "export function chunk<T>(xs: T[], size: number): T[][] {\n" +
        "  const out: T[][] = [];\n" +
        "  for (let i = 0; i < xs.length; i += size) {\n" +
        "    out.push(xs.slice(i, i + size));\n" +
        "  }\n" +
        "  return out;\n" +
        "}\n",
    },
  },
];
