/**
 * 离线测试：验证统一模型在多轮工具调用场景下的关键不变量。
 * （provider 内部映射函数不导出，这里测公共行为：registry 解析 + 消息构造）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider, textMessage, toolCallsOf } from "../index.js";
import type { ChatMessage } from "../index.js";

test("registry: 解析 provider/model 前缀", () => {
  const a = createProvider("anthropic/claude-opus-4-8");
  assert.equal(a.provider.name, "anthropic");
  assert.equal(a.model, "claude-opus-4-8");

  const o = createProvider("openai/gpt-5.2");
  assert.equal(o.provider.name, "openai");
  assert.equal(o.model, "gpt-5.2");

  const ol = createProvider("ollama/qwen3");
  assert.equal(ol.provider.name, "ollama");
});

test("registry: 裸模型名按前缀推断", () => {
  assert.equal(createProvider("claude-opus-4-8").provider.name, "anthropic");
  assert.equal(createProvider("gpt-5.2").provider.name, "openai");
});

test("registry: 未知 provider 报错并列出可用项", () => {
  assert.throws(() => createProvider("nope/model-x"), /未知 provider/);
});

test("统一模型: 多轮工具调用的消息结构", () => {
  const history: ChatMessage[] = [textMessage("user", "现在几点？")];

  // 模型回复：文本 + 工具调用
  const assistant: ChatMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "我来查一下。" },
      { type: "tool_call", id: "call_1", name: "get_current_time", args: {} },
    ],
  };
  history.push(assistant);
  assert.equal(toolCallsOf(assistant).length, 1);

  // 工具结果回传
  history.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "get_current_time",
        content: "2026-07-13T12:00:00Z",
      },
    ],
  });

  assert.equal(history.length, 3);
  assert.equal(history[1]!.role, "assistant");
  assert.equal(history[2]!.content[0]!.type, "tool_result");
});
