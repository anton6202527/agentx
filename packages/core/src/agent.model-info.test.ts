import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import type { ProviderModelInfo } from "./provider/registry.js";
import { scriptedProvider } from "./testutil/scripted-provider.js";

function info(overrides: Partial<ProviderModelInfo> = {}): ProviderModelInfo {
  return {
    providerId: "compat",
    model: "small-model",
    capabilities: { tools: true, reasoning: false, images: false },
    limits: {},
    ...overrides,
  };
}

test("Agent model info: 未知兼容端点不强塞 maxTokens，并按能力省略 tools/effort", async () => {
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "small-model",
    modelInfo: info({ capabilities: { tools: false, reasoning: false } }),
    cwd: "/tmp",
    effort: "high",
    projectMemory: false,
  });

  for await (const _event of agent.send("hello")) {
    // consume
  }

  assert.equal(provider.calls[0]?.maxTokens, undefined);
  assert.equal(provider.calls[0]?.tools, undefined);
  assert.equal(provider.calls[0]?.effort, undefined);
});

test("Agent model info: 输出上限会收敛显式请求", async () => {
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "small-model",
    modelInfo: info({ limits: { contextWindow: 8_192, maxOutputTokens: 2_048 } }),
    cwd: "/tmp",
    maxTokens: 8_000,
    projectMemory: false,
  });

  for await (const _event of agent.send("hello")) {
    // consume
  }

  assert.equal(provider.calls[0]?.maxTokens, 2_048);
  assert.ok((provider.calls[0]?.tools?.length ?? 0) > 0);
});
