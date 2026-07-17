/**
 * tool_search / deferred 工具测试：
 *   - registry：deferred 不进 definitions()、激活后进入、subset/clone 保留标记
 *   - tool_search：关键词检索激活、select: 精确选取、无命中列出可选项
 *   - Agent 端到端：第一轮请求不含 deferred schema，tool_search 激活后下一轮包含，
 *     且直接调用未激活工具时自动激活（宽容语义）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { Agent } from "../agent.js";
import { scriptedProvider } from "../testutil/scripted-provider.js";
import { ToolRegistry, type Tool } from "./tool.js";
import { createToolSearchTool } from "./tool-search.js";
import { defaultTools } from "./index.js";

function fakeTool(name: string, description: string): Tool {
  return {
    def: { name, description, parameters: { type: "object", properties: {} } },
    readOnly: true,
    ruleKey: () => name,
    run: async () => `${name} ran`,
  };
}

test("registry: deferred 不进 definitions，激活后进入；subset 保留标记", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("visible", "always here"));
  reg.register(fakeTool("hidden_slack", "send slack messages"), { deferred: true });

  assert.deepEqual(
    reg.definitions().map((d) => d.name),
    ["visible"],
  );
  assert.ok(reg.hasDeferred());
  assert.ok(reg.isDeferred("hidden_slack"));

  const sub = reg.subset(["visible", "hidden_slack"]);
  assert.ok(sub.isDeferred("hidden_slack"), "subset 应保留 deferred 标记");

  assert.equal(reg.activate("hidden_slack"), true);
  assert.deepEqual(
    reg.definitions().map((d) => d.name),
    ["visible", "hidden_slack"],
  );
  assert.equal(reg.hasDeferred(), false);
});

test("tool_search: 关键词检索激活；select: 精确选取；无命中列出可选项", async () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("slack_send", "send a message to a slack channel"), { deferred: true });
  reg.register(fakeTool("jira_create", "create a jira issue"), { deferred: true });
  reg.register(fakeTool("gh_pr", "open a github pull request"), { deferred: true });
  const search = createToolSearchTool(reg);
  const ctx = { cwd: os.tmpdir(), signal: new AbortController().signal };

  const out = await search.run({ query: "slack message" }, ctx);
  assert.match(out, /slack_send/);
  assert.equal(reg.isDeferred("slack_send"), false, "命中即激活");
  assert.equal(reg.isDeferred("jira_create"), true, "未命中保持延迟");

  const picked = await search.run({ query: "select:jira_create,nope" }, ctx);
  assert.match(picked, /jira_create/);
  assert.match(picked, /未找到.*nope|Not found.*nope/);
  assert.equal(reg.isDeferred("jira_create"), false);

  const miss = await search.run({ query: "zzz-nothing" }, ctx);
  assert.match(miss, /gh_pr/, "无命中时应列出剩余可选工具名");
});

test("Agent 端到端: deferred schema 首轮不进请求，tool_search 激活后下一轮进入", async () => {
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "tool_search", args: { query: "slack" } }],
      },
    ],
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c2", name: "slack_send", args: {} }],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "已发送" }] }],
  ]);
  const tools = defaultTools();
  tools.register(fakeTool("slack_send", "send a message to a slack channel"), { deferred: true });
  const agent = new Agent({
    provider,
    model: "x",
    cwd: os.tmpdir(),
    tools,
    projectMemory: false,
    injectEnv: false,
    permission: { mode: "bypass" },
  });
  const events = [];
  for await (const ev of agent.send("给 slack 发消息")) events.push(ev);

  const toolNames = (i: number) => (provider.calls[i]!.tools ?? []).map((t) => t.name);
  assert.ok(toolNames(0).includes("tool_search"), "首轮应有 tool_search");
  assert.ok(!toolNames(0).includes("slack_send"), "deferred schema 首轮不应进请求");
  assert.ok(toolNames(1).includes("slack_send"), "激活后下一轮 schema 应进请求");
  const slackResult = events.find((e) => e.type === "tool_result" && e.name === "slack_send");
  assert.ok(slackResult && slackResult.type === "tool_result" && !slackResult.isError);
});

test("Agent 宽容语义: 直接调用未激活的 deferred 工具自动激活并执行", async () => {
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "hidden_x", args: {} }],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  ]);
  const tools = defaultTools();
  tools.register(fakeTool("hidden_x", "hidden tool"), { deferred: true });
  const agent = new Agent({
    provider,
    model: "x",
    cwd: os.tmpdir(),
    tools,
    projectMemory: false,
    injectEnv: false,
    permission: { mode: "bypass" },
  });
  const events = [];
  for await (const ev of agent.send("直接调 hidden_x")) events.push(ev);
  const result = events.find((e) => e.type === "tool_result" && e.name === "hidden_x");
  assert.ok(result && result.type === "tool_result" && !result.isError, "应自动激活并执行");
  assert.ok(
    (provider.calls[1]!.tools ?? []).some((t) => t.name === "hidden_x"),
    "激活后下一轮 schema 进请求",
  );
});
