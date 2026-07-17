/**
 * web_search：可插拔搜索工具。响应解析是纯函数（离线测），网络 fetch 可注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWebSearchTool,
  formatSearchResults,
  parseTavilyResponse,
  parseBraveResponse,
  tavilyBackend,
  webSearchBackendFromEnv,
  type WebSearchBackend,
} from "./web-search.js";
import { ToolError } from "./tool.js";

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal });

test("parseTavilyResponse: results→统一结果，丢弃无 url 项", () => {
  const out = parseTavilyResponse({
    results: [{ title: "A", url: "https://a.test", content: "snippet a" }, { title: "no-url" }],
  });
  assert.deepEqual(out, [{ title: "A", url: "https://a.test", snippet: "snippet a" }]);
});

test("parseBraveResponse: web.results→统一结果", () => {
  const out = parseBraveResponse({
    web: { results: [{ title: "B", url: "https://b.test", description: "desc b" }] },
  });
  assert.deepEqual(out, [{ title: "B", url: "https://b.test", snippet: "desc b" }]);
});

test("parseBraveResponse: 结构缺失时返回空数组而不抛", () => {
  assert.deepEqual(parseBraveResponse({}), []);
  assert.deepEqual(parseBraveResponse(null), []);
});

test("formatSearchResults: 编号 + URL + 摘要，并提示可 webfetch", () => {
  const out = formatSearchResults("q", [
    { title: "标题", url: "https://x.test", snippet: "一段摘要" },
  ]);
  assert.match(out, /1\. 标题/);
  assert.match(out, /https:\/\/x\.test/);
  assert.match(out, /一段摘要/);
  assert.match(out, /webfetch/);
});

test("formatSearchResults: 空结果给出无结果提示", () => {
  assert.match(formatSearchResults("找不到的东西", []), /web_search/);
});

test("createWebSearchTool: 调用后端并格式化；query 为空报错", async () => {
  const backend: WebSearchBackend = async (q) => [
    { title: `for ${q}`, url: "https://r.test", snippet: "s" },
  ];
  const tool = createWebSearchTool(backend);
  assert.equal(tool.readOnly, true);
  const out = await tool.run({ query: "typescript 5.6" }, ctx());
  assert.match(out, /for typescript 5\.6/);
  await assert.rejects(() => tool.run({ query: "  " }, ctx()), ToolError);
});

test("createWebSearchTool: 后端抛错被包成 ToolError（不外溢）", async () => {
  const backend: WebSearchBackend = async () => {
    throw new Error("upstream 503");
  };
  const tool = createWebSearchTool(backend);
  await assert.rejects(() => tool.run({ query: "x" }, ctx()), /web_search/);
});

test("createWebSearchTool: count 被夹到 [1,10]", async () => {
  let received = 0;
  const backend: WebSearchBackend = async (_q, o) => {
    received = o.count ?? -1;
    return [];
  };
  const tool = createWebSearchTool(backend);
  await tool.run({ query: "x", count: 999 }, ctx());
  assert.equal(received, 10);
});

test("tavilyBackend: 注入 fetch，POST 带 api_key 与 query，解析结果", async () => {
  let sentUrl = "";
  let sentBody: any = null;
  const fakeFetch = (async (url: any, init: any) => {
    sentUrl = String(url);
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [{ title: "T", url: "https://t.test", content: "c" }] }),
    } as any;
  }) as typeof fetch;
  const backend = tavilyBackend({ apiKey: "k-123", fetchImpl: fakeFetch });
  const results = await backend("hello", { signal: new AbortController().signal, count: 3 });
  assert.match(sentUrl, /tavily/);
  assert.equal(sentBody.api_key, "k-123");
  assert.equal(sentBody.query, "hello");
  assert.equal(sentBody.max_results, 3);
  assert.deepEqual(results, [{ title: "T", url: "https://t.test", snippet: "c" }]);
});

test("webSearchBackendFromEnv: TAVILY 优先于 BRAVE；都无则 undefined", () => {
  assert.ok(webSearchBackendFromEnv({ TAVILY_API_KEY: "x", BRAVE_SEARCH_API_KEY: "y" } as any));
  assert.ok(webSearchBackendFromEnv({ BRAVE_SEARCH_API_KEY: "y" } as any));
  assert.equal(webSearchBackendFromEnv({} as any), undefined);
});
