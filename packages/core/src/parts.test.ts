import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messagesToParts,
  PartsProjector,
  type MessageToolPart,
  type ProjectedEvent,
} from "./parts.js";
import type { ChatMessage } from "./types.js";
import type { AgentEvent } from "./agent.js";

const SID = "s_test_0001";

test("messagesToParts: tool_result 折叠进 assistant 的 tool part，id 确定性", () => {
  const history: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "你好" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "想一想" },
        { type: "text", text: "我来读文件" },
        { type: "tool_call", id: "call_1", name: "read", args: { path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read",
          content: "内容",
          isError: false,
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "完成" }] },
  ];
  const out = messagesToParts(SID, history);
  // 纯 tool_result 的回传消息不独立成条 → 3 条消息
  assert.equal(out.length, 3);
  assert.equal(out[0]!.info.role, "user");
  assert.equal(out[1]!.info.role, "assistant");
  assert.deepEqual(
    out[1]!.parts.map((p) => p.type),
    ["reasoning", "text", "tool"],
  );
  const tool = out[1]!.parts[2] as MessageToolPart;
  assert.equal(tool.tool, "read");
  assert.equal(tool.callId, "call_1");
  assert.equal(tool.state.status, "completed");
  assert.equal((tool.state as { output: string }).output, "内容");
  assert.deepEqual((tool.state as { input: unknown }).input, { path: "a.ts" });
  // 确定性：重复投影 id 一致
  const again = messagesToParts(SID, history);
  assert.deepEqual(
    out.flatMap((m) => [m.info.id, ...m.parts.map((p) => p.id)]),
    again.flatMap((m) => [m.info.id, ...m.parts.map((p) => p.id)]),
  );
});

test("messagesToParts: internal 文本标记 synthetic，isError 变 error 态", () => {
  const history: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "<env>", internal: true }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c2", name: "bash", args: { cmd: "rm" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "c2", toolName: "bash", content: "拒绝", isError: true },
      ],
    },
  ];
  const out = messagesToParts(SID, history);
  assert.equal(out[0]!.parts[0]!.type, "text");
  assert.equal((out[0]!.parts[0] as { synthetic?: boolean }).synthetic, true);
  const tool = out[1]!.parts[0] as MessageToolPart;
  assert.equal(tool.state.status, "error");
  assert.equal((tool.state as { error: string }).error, "拒绝");
});

function drive(projector: PartsProjector, events: AgentEvent[]): ProjectedEvent[] {
  return events.flatMap((e) => projector.handle(e));
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("PartsProjector: 完整 drive —— 四态机/step 包夹/delta 汇流", () => {
  let clock = 1000;
  const p = new PartsProjector(SID, { now: () => clock++, rand: () => 0.5 });
  const out = drive(p, [
    { type: "user_message", text: "改一下", queued: false },
    { type: "text", text: "我先" },
    { type: "text", text: "看看" },
    { type: "tool_input_delta", id: "c1", name: "read", delta: '{"path":' },
    { type: "tool_input_delta", id: "c1", name: "read", delta: '"a.ts"}' },
    { type: "turn_end", usage },
    { type: "tool_start", id: "c1", name: "read", ruleKey: "read" },
    { type: "tool_result", id: "c1", name: "read", content: "内容", isError: false },
    { type: "text", text: "改完了" },
    { type: "turn_end", usage },
    { type: "done", usage, turns: 2, costUSD: 0.01 },
  ]);

  const types = out.map((e) => e.type);
  // 首事件：user 消息
  assert.equal(types[0], "message.updated");
  const userInfo = (out[0] as { properties: { info: { role: string } } }).properties.info;
  assert.equal(userInfo.role, "user");

  // 文本增量：两条 delta 同一 partId
  const deltas = out.filter((e) => e.type === "message.part.delta");
  const textDeltas = deltas.filter((d) => d.properties.field === "text");
  assert.equal(textDeltas.length, 3); // 我先/看看/改完了
  assert.equal(textDeltas[0]!.properties.partId, textDeltas[1]!.properties.partId);
  assert.notEqual(textDeltas[1]!.properties.partId, textDeltas[2]!.properties.partId);

  // 工具四态：pending（创建）→ running → completed
  const toolUpdates = out
    .filter(
      (e): e is Extract<ProjectedEvent, { type: "message.part.updated" }> =>
        e.type === "message.part.updated",
    )
    .map((e) => e.properties.part)
    .filter((p): p is MessageToolPart => p.type === "tool");
  assert.deepEqual(
    toolUpdates.map((tp) => tp.state.status),
    ["pending", "running", "completed"],
  );
  const completed = toolUpdates[2]!.state as { input: unknown; output: string; time?: object };
  assert.deepEqual(completed.input, { path: "a.ts" });
  assert.equal(completed.output, "内容");
  assert.ok(completed.time, "completed 应带时间");

  // step 包夹：两个模型回合 → 2× step-start + 2× step-finish
  const stepParts = out
    .filter(
      (e): e is Extract<ProjectedEvent, { type: "message.part.updated" }> =>
        e.type === "message.part.updated",
    )
    .map((e) => e.properties.part.type)
    .filter((t) => t.startsWith("step-"));
  assert.deepEqual(stepParts, ["step-start", "step-finish", "step-start", "step-finish"]);

  // done：assistant 完成态带 tokens/cost
  const last = out[out.length - 1] as {
    properties: {
      info: { role: string; time: { completed?: number }; tokens?: object; costUSD?: number };
    };
  };
  assert.equal(last.properties.info.role, "assistant");
  assert.ok(last.properties.info.time.completed);
  assert.deepEqual(last.properties.info.tokens, usage);
  assert.equal(last.properties.info.costUSD, 0.01);

  // 所有 part 隶属同一条 assistant 消息（user 的除外）
  const assistantMsgIds = new Set(
    out
      .filter(
        (e): e is Extract<ProjectedEvent, { type: "message.part.updated" }> =>
          e.type === "message.part.updated",
      )
      .map((e) => e.properties.part.messageId),
  );
  assert.equal(assistantMsgIds.size, 2); // user 文本 part 的消息 + assistant 消息
});

test("PartsProjector: error 收尾 assistant 并携带错误", () => {
  const p = new PartsProjector(SID, { now: () => 1, rand: () => 0.5 });
  const out = drive(p, [
    { type: "user_message", text: "hi", queued: false },
    { type: "text", text: "部分输出" },
    { type: "error", message: "boom" },
  ]);
  const last = out[out.length - 1] as { type: string; properties: { info: { error?: string } } };
  assert.equal(last.type, "message.updated");
  assert.equal(last.properties.info.error, "boom");
});

test("PartsProjector: 会话级事件不产生投影", () => {
  const p = new PartsProjector(SID);
  assert.deepEqual(p.handle({ type: "compacted", beforeTokens: 10, afterTokens: 5 }), []);
  assert.deepEqual(p.handle({ type: "retry", attempt: 1, delayMs: 100, reason: "x" }), []);
});
