/**
 * OpenAI 兼容 provider —— 覆盖 OpenAI 官方 + 一切 OpenAI 兼容端点
 * （Ollama / DeepSeek / vLLM / OpenRouter 等），通过 baseURL 区分。
 *
 * 映射降级说明：
 * - thinking 块不回传（OpenAI 协议无对应物；o 系推理在服务端内部）
 * - tool_result 在 OpenAI 里是独立的 role:"tool" 消息，从统一模型的
 *   user 消息中拆出来，顺序保持在文本之前
 */

import OpenAI from "openai";
import type {
  ChatMessage,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolCallPart,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";

export interface OpenAICompatOptions {
  /** 显示名，如 "openai" / "ollama" / "deepseek" */
  name?: string;
  apiKey?: string;
  baseURL?: string;
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatOptions = {}) {
    this.name = opts.name ?? "openai";
    this.client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
        ...(req.effort ? { reasoning_effort: mapEffort(req.effort) } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        messages: toOpenAIMessages(req.system, req.messages),
      },
      { ...(req.signal ? { signal: req.signal } : {}) },
    );

    // 按 OpenAI 的 tool_calls index 聚合参数分片
    const pending = new Map<number, { id: string; name: string; json: string }>();
    const textParts: string[] = [];
    let finishReason: string | null = null;
    let usage: Usage = emptyUsage();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        textParts.push(choice.delta.content);
        yield { type: "text_delta", text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        let entry = pending.get(tc.index);
        if (!entry) {
          entry = { id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? "", json: "" };
          pending.set(tc.index, entry);
          yield { type: "tool_call_start", id: entry.id, name: entry.name };
        }
        if (tc.function?.arguments) {
          entry.json += tc.function.arguments;
          yield { type: "tool_call_delta", id: entry.id, argsText: tc.function.arguments };
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0, // OpenAI 缓存写入不单独计费/上报
        };
      }
    }

    // 聚合 assistant 消息
    const toolCalls: ToolCallPart[] = [];
    for (const [, t] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      const part = parseToolCall(t);
      toolCalls.push(part);
      yield { type: "tool_call_end", part };
    }
    const message: ChatMessage = {
      role: "assistant",
      content: [
        ...(textParts.length ? [{ type: "text" as const, text: textParts.join("") }] : []),
        ...toolCalls,
      ],
    };

    yield {
      type: "done",
      stopReason: mapStopReason(finishReason, toolCalls.length > 0),
      message,
      usage,
    };
  }
}

// ---------- 统一模型 → OpenAI ----------

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      const toolCalls = m.content
        .filter((p): p is ToolCallPart => p.type === "tool_call")
        .map((p) => ({
          id: p.id,
          type: "function" as const,
          function: { name: p.name, arguments: JSON.stringify(p.args) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user 消息：tool_result 拆成独立 role:"tool" 消息（必须紧跟对应 assistant 轮）
    for (const part of m.content) {
      if (part.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: part.isError ? `[tool error] ${part.content}` : part.content,
        });
      }
    }
    const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        userParts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        userParts.push({
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
      }
    }
    if (userParts.length) out.push({ role: "user", content: userParts });
  }
  return out;
}

function parseToolCall(t: { id: string; name: string; json: string }): ToolCallPart {
  let args: Record<string, unknown> = {};
  try {
    args = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
  } catch {
    args = { __unparsed: t.json };
  }
  return { type: "tool_call", id: t.id, name: t.name, args };
}

function mapEffort(effort: string): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high"; // high / xhigh / max → high
}

function mapStopReason(reason: string | null, hasToolCalls: boolean): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
      // 部分兼容端点在带工具调用结束时也报 "stop"
      return hasToolCalls ? "tool_use" : "end_turn";
    default:
      return hasToolCalls ? "tool_use" : "other";
  }
}
