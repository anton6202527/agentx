import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, probeLocalProviders } from "./probe.js";
import { listProviderDetails } from "./registry.js";

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
  const details = listProviderDetails();
  // ollama 在跑、其余本地端点连不上。
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("11434")) return new Response("{}", { status: 200 });
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const live = await probeLocalProviders(details, {}, fetchImpl);
  assert.ok(live.has("ollama"), "ollama 应被标为在跑");
  assert.ok(!live.has("lmstudio"), "未响应的本地 provider 不应在集合里");
  // 云端 provider（anthropic/openai）不是本地，不参与探测。
  assert.ok(!live.has("anthropic"));
});
