/**
 * 脚本化假 provider —— 测试专用。每次 stream() 按序消费一条脚本（一轮的
 * assistant 消息），并完整模拟流式事件序列（text_delta / tool_call_* / done）。
 * calls 记录每次请求，供断言「provider 实际收到了什么」。
 */

import type { ChatMessage, Provider, StreamEvent, StreamRequest } from "../types.js";

export interface ScriptedProvider extends Provider {
  calls: StreamRequest[];
}

export function scriptedProvider(scripts: ChatMessage[][]): ScriptedProvider {
  let turn = 0;
  const calls: StreamRequest[] = [];
  return {
    name: "scripted",
    calls,
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      // Agent 会原地追加 history；测试记录必须冻结调用当时的请求视图。
      calls.push({
        ...req,
        messages: structuredClone(req.messages),
        ...(req.tools ? { tools: structuredClone(req.tools) } : {}),
      });
      const msg = scripts[turn++] ?? [];
      const content = msg[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content) {
        if (part.type === "text") {
          yield { type: "text_delta", text: part.text };
        } else if (part.type === "tool_call") {
          yield { type: "tool_call_start", id: part.id, name: part.name };
          yield { type: "tool_call_delta", id: part.id, argsText: JSON.stringify(part.args) };
          yield { type: "tool_call_end", part };
        }
      }
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}
