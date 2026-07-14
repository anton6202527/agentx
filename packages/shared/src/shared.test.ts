import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, diffLines, diffStat } from "./index.js";

test("markdown: 围栏代码块解析为 code 块并保留语言", () => {
  const blocks = parseMarkdown("前言\n\n```ts\nconst x = 1\n```\n后语");
  const code = blocks.find((b) => b.kind === "code");
  assert.ok(code && code.kind === "code");
  assert.equal(code.lang, "ts");
  assert.equal(code.code, "const x = 1");
  assert.ok(blocks.some((b) => b.kind === "paragraph"));
});

test("markdown: 行内 code / bold / link 解析为 span", () => {
  const spans = parseInline("用 `npm test` 跑 **全部**，见 [文档](https://example.com)");
  const kinds = spans.map((s) => s.t);
  assert.ok(kinds.includes("code"));
  assert.ok(kinds.includes("strong"));
  const link = spans.find((s) => s.t === "link");
  assert.ok(link && link.t === "link" && link.href === "https://example.com");
});

test("markdown: 有序 / 无序列表", () => {
  const ul = parseMarkdown("- 一\n- 二");
  assert.ok(ul[0]?.kind === "list" && !ul[0].ordered && ul[0].items.length === 2);
  const ol = parseMarkdown("1. 甲\n2. 乙");
  assert.ok(ol[0]?.kind === "list" && ol[0].ordered);
});

test("markdown: 标题记录层级", () => {
  const blocks = parseMarkdown("## 小标题");
  assert.ok(blocks[0]?.kind === "heading" && blocks[0].level === 2);
});

test("diff: 行级 LCS 标记增删，公共行为 ctx", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(d, [
    { t: "ctx", text: "a" },
    { t: "del", text: "b" },
    { t: "add", text: "B" },
    { t: "ctx", text: "c" },
    { t: "add", text: "d" },
  ]);
  assert.deepEqual(diffStat(d), { added: 2, removed: 1 });
});

test("diff: 空旧文本 → 全部新增", () => {
  const d = diffLines("", "x\ny");
  assert.deepEqual(d, [
    { t: "add", text: "x" },
    { t: "add", text: "y" },
  ]);
});
