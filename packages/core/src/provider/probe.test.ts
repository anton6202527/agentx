import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, probeLocalProviders } from "./probe.js";
import { listProviderDetails, registerOpenAICompatibleProvider } from "./registry.js";

test("probeEndpoint: 有 HTTP 响应视为在跑，连接错误视为未运行", async () => {
  const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://127.0.0.1:11434/v1", 600, ok), true);

  const unauthorized = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://x/v1", 600, unauthorized), true);

  const refused = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://x/v1", 600, refused), false);
});

test("probeLocalProviders: 只探测本地端点，返回在跑的 provider 集合", async () => {
  // 精简后的内置注册表已无本地 provider；用 fixture 本地端点验证探测逻辑。
  registerOpenAICompatibleProvider({
    id: "probe-fixture-live",
    baseURL: "http://127.0.0.1:11434/v1",
    local: true,
    requiresApiKey: false,
  });
  registerOpenAICompatibleProvider({
    id: "probe-fixture-down",
    baseURL: "http://127.0.0.1:65001/v1",
    local: true,
    requiresApiKey: false,
  });
  const details = listProviderDetails();
  // 11434 在跑、其余本地端点连不上。
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("11434")) return new Response("{}", { status: 200 });
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const live = await probeLocalProviders(details, {}, fetchImpl);
  assert.ok(live.has("probe-fixture-live"), "在跑的本地 fixture 应被标为在跑");
  assert.ok(!live.has("probe-fixture-down"), "未响应的本地 provider 不应在集合里");
  // 云端 provider（DeepSeek）不是本地，不参与探测。
  assert.ok(!live.has("deepseek"));
});
