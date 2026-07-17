/**
 * Agent 多模态回路：工具经 ctx.attachImage 附带的图片必须进入历史，
 * 且必须排在本轮全部 tool_result 之后 —— Anthropic 要求 tool_result 块位于
 * user 消息开头，顺序错了整轮请求会被拒。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import type { Provider, StreamEvent, ChatMessage, ContentPart } from "./types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const msg = scripts[turn++] ?? [];
      const content = msg[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** 一个总是附带一张图的假只读工具。 */
function imageTool(name: string): Tool {
  return {
    readOnly: true,
    def: { name, description: "test", parameters: { type: "object", properties: {} } },
    ruleKey: () => name,
    async run(_input, ctx) {
      ctx.attachImage?.({
        type: "image",
        mediaType: "image/png",
        data: PNG_1X1.toString("base64"),
      });
      return `${name} done`;
    },
  };
}

async function drain(agent: Agent, text: string): Promise<void> {
  for await (const _ of agent.send(text)) {
    /* 消费完 */
  }
}

/** 取历史里承载工具结果的那条 user 消息。 */
function resultMessage(agent: Agent): ContentPart[] {
  const msg = agent.messages.find(
    (m) => m.role === "user" && m.content.some((p) => p.type === "tool_result"),
  );
  assert.ok(msg, "应存在承载 tool_result 的 user 消息");
  return msg!.content;
}

test("Agent: 工具附带的图片进入历史，且排在 tool_result 之后", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agent-img-"));
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "shot", args: {} }] }],
    [{ role: "assistant", content: [{ type: "text", text: "看到了" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    modelInfo: {
      providerId: "p",
      model: "x",
      capabilities: { tools: true, images: true },
      limits: {},
    },
    cwd: dir,
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry().register(imageTool("shot")),
    permission: { mode: "auto" },
  });
  await drain(agent, "看下截图");

  const content = resultMessage(agent);
  const firstImage = content.findIndex((p) => p.type === "image");
  const lastResult = content.map((p) => p.type).lastIndexOf("tool_result");
  assert.ok(firstImage >= 0, "图片应进入历史");
  assert.ok(lastResult >= 0, "tool_result 应在历史中");
  assert.ok(firstImage > lastResult, "图片必须排在所有 tool_result 之后（Anthropic 硬性要求）");
  const img = content[firstImage]!;
  assert.equal(img.type === "image" && img.mediaType, "image/png");
});

test("Agent: 模型不支持视觉时，工具拿到的 modelSupportsImages 为 false", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agent-novision-"));
  let sawFlag: boolean | undefined = undefined;
  const probe: Tool = {
    readOnly: true,
    def: { name: "probe", description: "t", parameters: { type: "object", properties: {} } },
    ruleKey: () => "probe",
    async run(_i, ctx) {
      sawFlag = ctx.modelSupportsImages;
      return "ok";
    },
  };
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "probe", args: {} }] }],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    modelInfo: {
      providerId: "p",
      model: "x",
      capabilities: { tools: true, images: false },
      limits: {},
    },
    cwd: dir,
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry().register(probe),
    permission: { mode: "auto" },
  });
  await drain(agent, "跑一下");
  assert.equal(sawFlag, false);
});

test("Agent: 能力未知（无 modelInfo）时保守按不支持视觉处理", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agent-unknown-"));
  let sawFlag: boolean | undefined = undefined;
  const probe: Tool = {
    readOnly: true,
    def: { name: "probe", description: "t", parameters: { type: "object", properties: {} } },
    ruleKey: () => "probe",
    async run(_i, ctx) {
      sawFlag = ctx.modelSupportsImages;
      return "ok";
    },
  };
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "probe", args: {} }] }],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry().register(probe),
    permission: { mode: "auto" },
  });
  await drain(agent, "跑一下");
  assert.equal(sawFlag, false, "未知能力必须保守按 false，否则整轮请求可能被 provider 拒绝");
});

test("Agent: 工具失败时不把图片塞进历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agent-imgfail-"));
  const failing: Tool = {
    readOnly: true,
    def: { name: "shot", description: "t", parameters: { type: "object", properties: {} } },
    ruleKey: () => "shot",
    async run(_i, ctx) {
      ctx.attachImage?.({ type: "image", mediaType: "image/png", data: "x" });
      throw new Error("boom");
    },
  };
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "shot", args: {} }] }],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    modelInfo: {
      providerId: "p",
      model: "x",
      capabilities: { tools: true, images: true },
      limits: {},
    },
    cwd: dir,
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry().register(failing),
    permission: { mode: "auto" },
  });
  await drain(agent, "跑一下");
  const content = resultMessage(agent);
  assert.ok(!content.some((p) => p.type === "image"), "失败的工具结果不应附带图片（白烧上下文）");
});
