/**
 * Message + Parts 投影层（对齐 opencode 的消息模型）。
 *
 * opencode 的 API 面把一次对话表达为 `Message(info) + Part[]`：文本/推理/工具
 * 各成一个带稳定 id 的 part，工具 part 有 pending→running→completed|error 四态机，
 * 流式文本走 `message.part.delta` 增量事件。这让任何客户端（SDK/Web/IDE）都能
 * 做 UI 无关的渲染与精确增量更新。
 *
 * anicode 的内部真相仍是 `ChatMessage[]`（持久化不变）——本模块只做投影：
 *   - `messagesToParts`：从持久化历史重建（确定性 id，重复调用结果稳定）
 *   - `PartsProjector`：把 AgentEvent 实时流投影成 part 事件（时间有序 id）
 * 两者共用同一套 wire 类型，是 HTTP API 与 SDK 的消息形状单一事实源。
 */

import type { AgentEvent } from "./agent.js";
import type { ChatMessage, Usage } from "./types.js";
import { createId, deterministicId, type IdPrefix } from "./id.js";

// ---------- wire 类型：Message ----------

interface MessageInfoBase {
  id: string;
  sessionId: string;
  time: { created: number };
}

export interface UserMessageInfo extends MessageInfoBase {
  role: "user";
}

export interface AssistantMessageInfo extends MessageInfoBase {
  role: "assistant";
  time: { created: number; completed?: number };
  /** 会话累计 usage（done 事件聚合值）。 */
  tokens?: Usage;
  costUSD?: number;
  error?: string;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

// ---------- wire 类型：Part ----------

interface MessagePartBase {
  id: string;
  sessionId: string;
  messageId: string;
}

export interface MessageTextPart extends MessagePartBase {
  type: "text";
  text: string;
  /** 内部注入的上下文（如环境接地块），UI 不应当作用户原话展示。 */
  synthetic?: boolean;
}

export interface MessageReasoningPart extends MessagePartBase {
  type: "reasoning";
  text: string;
}

export interface MessageFilePart extends MessagePartBase {
  type: "file";
  mime: string;
  /** data URI（base64）。 */
  url: string;
}

/** 一次模型回合开始（一条 assistant 消息内可有多个回合）。 */
export interface MessageStepStartPart extends MessagePartBase {
  type: "step-start";
}

/** 一次模型回合结束，附带该回合 usage。 */
export interface MessageStepFinishPart extends MessagePartBase {
  type: "step-finish";
  tokens: Usage;
}

export type ToolPartState =
  | { status: "pending"; inputText?: string }
  | { status: "running"; input?: unknown; metadata?: unknown; time: { start: number } }
  | {
      status: "completed";
      input?: unknown;
      output: string;
      time?: { start: number; end: number };
    }
  | { status: "error"; input?: unknown; error: string; time?: { start: number; end: number } };

export interface MessageToolPart extends MessagePartBase {
  type: "tool";
  /** provider 的 tool_call id，与 ChatMessage 里的 ToolCallPart.id 对应。 */
  callId: string;
  tool: string;
  state: ToolPartState;
}

export type MessagePart =
  | MessageTextPart
  | MessageReasoningPart
  | MessageFilePart
  | MessageStepStartPart
  | MessageStepFinishPart
  | MessageToolPart;

// ---------- 投影事件 ----------

export type ProjectedEvent =
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.part.updated"; properties: { part: MessagePart } }
  | {
      type: "message.part.delta";
      properties: {
        sessionId: string;
        messageId: string;
        partId: string;
        field: "text" | "input";
        delta: string;
      };
    };

// ---------- 从持久化历史重建 ----------

/**
 * 把持久化的 `ChatMessage[]` 重建成 Message+Parts 投影。
 *
 * 映射规则：
 *   - user 消息里的 tool_result 折叠进前文 assistant 的对应 tool part（完成态），
 *     纯 tool_result 的 user 消息不单独成一条消息；
 *   - internal 文本标记为 synthetic；image 变 data URI file part。
 * id 是位置确定性的：同一会话同一历史，投影结果永远一致。
 */
export function messagesToParts(sessionId: string, messages: ChatMessage[]): MessageWithParts[] {
  const out: MessageWithParts[] = [];
  const toolParts = new Map<string, MessageToolPart>();
  const id = (prefix: IdPrefix, ...idx: number[]) => deterministicId(prefix, sessionId, ...idx);

  messages.forEach((msg, i) => {
    const messageId = id("msg", i);
    const parts: MessagePart[] = [];
    const base = { sessionId, messageId };

    msg.content.forEach((part, j) => {
      const partId = id("prt", i, j);
      switch (part.type) {
        case "text":
          parts.push({
            ...base,
            id: partId,
            type: "text",
            text: part.text,
            ...(part.internal ? { synthetic: true } : {}),
          });
          break;
        case "thinking":
          parts.push({ ...base, id: partId, type: "reasoning", text: part.text });
          break;
        case "image":
          parts.push({
            ...base,
            id: partId,
            type: "file",
            mime: part.mediaType,
            url: `data:${part.mediaType};base64,${part.data}`,
          });
          break;
        case "tool_call": {
          const tool: MessageToolPart = {
            ...base,
            id: partId,
            type: "tool",
            callId: part.id,
            tool: part.name,
            state: { status: "pending", inputText: JSON.stringify(part.args) },
          };
          toolParts.set(part.id, tool);
          parts.push(tool);
          break;
        }
        case "tool_result": {
          const tool = toolParts.get(part.toolCallId);
          if (tool) {
            tool.state = part.isError
              ? { status: "error", input: parseInput(tool.state), error: part.content }
              : { status: "completed", input: parseInput(tool.state), output: part.content };
          }
          break;
        }
      }
    });

    if (parts.length === 0) return; // 纯 tool_result 的回传消息不独立成条
    const info: MessageInfo =
      msg.role === "user"
        ? { id: messageId, sessionId, role: "user", time: { created: 0 } }
        : { id: messageId, sessionId, role: "assistant", time: { created: 0 } };
    out.push({ info, parts });
  });
  return out;
}

function parseInput(state: ToolPartState): unknown {
  const text = state.status === "pending" ? state.inputText : undefined;
  if (text === undefined) return "input" in state ? state.input : undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ---------- 实时投影 ----------

export interface PartsProjectorOptions {
  now?: () => number;
  rand?: () => number;
}

/**
 * 把一个会话的 AgentEvent 实时流投影成 part 级事件。
 *
 * 每条 assistant 消息覆盖一次完整 drive（user_message → … → done），其中每个
 * 模型回合由 step-start / step-finish part 包夹（对齐 opencode 的 Step parts）。
 * 会话级事件（checkpoint/compacted/retry 等）不在此层，由 SessionEvent 透传。
 */
export class PartsProjector {
  private sessionId: string;
  private now: () => number;
  private rand: () => number;
  private assistant?: AssistantMessageInfo;
  /** 当前开放的流式文本/推理 part（互斥）。 */
  private open?: MessageTextPart | MessageReasoningPart;
  private stepOpen = false;
  private tools = new Map<string, { part: MessageToolPart; inputText: string; start?: number }>();

  constructor(sessionId: string, opts: PartsProjectorOptions = {}) {
    this.sessionId = sessionId;
    this.now = opts.now ?? Date.now;
    this.rand = opts.rand ?? Math.random;
  }

  private id(prefix: IdPrefix): string {
    return createId(prefix, this.now(), this.rand);
  }

  /** 事件携带不可变快照：内部状态继续演进不回写已发射的事件。 */
  private partEvent(part: MessagePart): ProjectedEvent {
    return { type: "message.part.updated", properties: { part: structuredClone(part) } };
  }

  private infoEvent(info: MessageInfo): ProjectedEvent {
    return { type: "message.updated", properties: { info: structuredClone(info) } };
  }

  handle(event: AgentEvent): ProjectedEvent[] {
    switch (event.type) {
      case "user_message": {
        const out = this.finishAssistant();
        const messageId = this.id("msg");
        const info: UserMessageInfo = {
          id: messageId,
          sessionId: this.sessionId,
          role: "user",
          time: { created: this.now() },
        };
        const part: MessageTextPart = {
          id: this.id("prt"),
          sessionId: this.sessionId,
          messageId,
          type: "text",
          text: event.text,
        };
        out.push(this.infoEvent(info), this.partEvent(part));
        return out;
      }
      case "text":
        return this.appendStreaming("text", event.text);
      case "thinking":
        return this.appendStreaming("reasoning", event.text);
      case "tool_input_delta": {
        const out = this.closeOpen(this.ensureAssistant());
        let entry = this.tools.get(event.id);
        if (!entry) {
          entry = { part: this.newToolPart(event.id, event.name), inputText: "" };
          this.tools.set(event.id, entry);
          out.push(this.partEvent(entry.part));
        }
        entry.inputText += event.delta;
        if (entry.part.state.status === "pending") entry.part.state.inputText = entry.inputText;
        out.push({
          type: "message.part.delta",
          properties: {
            sessionId: this.sessionId,
            messageId: entry.part.messageId,
            partId: entry.part.id,
            field: "input",
            delta: event.delta,
          },
        });
        return out;
      }
      case "tool_start": {
        const out = this.closeOpen(this.ensureAssistant());
        let entry = this.tools.get(event.id);
        if (!entry) {
          entry = { part: this.newToolPart(event.id, event.name), inputText: "" };
          this.tools.set(event.id, entry);
        }
        entry.start = this.now();
        entry.part.state = {
          status: "running",
          input: tryParse(entry.inputText),
          time: { start: entry.start },
        };
        out.push(this.partEvent(entry.part));
        return out;
      }
      case "tool_progress": {
        const entry = this.tools.get(event.id);
        if (!entry || entry.part.state.status !== "running") return [];
        entry.part.state.metadata = event.event;
        return [this.partEvent(entry.part)];
      }
      case "tool_result": {
        const entry = this.tools.get(event.id);
        if (!entry) return [];
        const time = entry.start ? { start: entry.start, end: this.now() } : undefined;
        const input =
          entry.part.state.status === "running"
            ? entry.part.state.input
            : tryParse(entry.inputText);
        entry.part.state = event.isError
          ? { status: "error", input, error: event.content, ...(time ? { time } : {}) }
          : { status: "completed", input, output: event.content, ...(time ? { time } : {}) };
        this.tools.delete(event.id);
        return [this.partEvent(entry.part)];
      }
      case "turn_end": {
        const info = this.assistant;
        if (!info) return [];
        const out = this.closeOpen(info);
        if (this.stepOpen) {
          this.stepOpen = false;
          const part: MessageStepFinishPart = {
            id: this.id("prt"),
            sessionId: this.sessionId,
            messageId: info.id,
            type: "step-finish",
            tokens: event.usage,
          };
          out.push({ type: "message.part.updated", properties: { part } });
        }
        return out;
      }
      case "done": {
        const info = this.assistant;
        if (!info) return [];
        const out = this.closeOpen(info);
        info.time.completed = this.now();
        info.tokens = event.usage;
        if (event.costUSD !== undefined) info.costUSD = event.costUSD;
        out.push(this.infoEvent(info));
        this.reset();
        return out;
      }
      case "error": {
        const info = this.assistant;
        if (!info) return [];
        const out = this.closeOpen(info);
        info.time.completed = this.now();
        info.error = event.message;
        out.push(this.infoEvent(info));
        this.reset();
        return out;
      }
      default:
        // 会话级事件（checkpoint/compacted/retry/fallback/…）由 SessionEvent 透传。
        return [];
    }
  }

  private reset(): void {
    delete this.assistant;
    delete this.open;
    this.stepOpen = false;
    this.tools.clear();
  }

  /** drive 结束（新 user_message 到来时兜底收尾未 done 的 assistant）。 */
  private finishAssistant(): ProjectedEvent[] {
    const info = this.assistant;
    if (!info) return [];
    const out = this.closeOpen(info);
    this.reset();
    return out;
  }

  private ensureAssistant(): { info: AssistantMessageInfo; events: ProjectedEvent[] } {
    if (this.assistant) return { info: this.assistant, events: [] };
    const info: AssistantMessageInfo = {
      id: this.id("msg"),
      sessionId: this.sessionId,
      role: "assistant",
      time: { created: this.now() },
    };
    this.assistant = info;
    this.stepOpen = true;
    const step: MessageStepStartPart = {
      id: this.id("prt"),
      sessionId: this.sessionId,
      messageId: info.id,
      type: "step-start",
    };
    return { info, events: [this.infoEvent(info), this.partEvent(step)] };
  }

  /** 关闭当前开放的流式 part（发终态 updated）。 */
  private closeOpen(
    infoOrEnsure: AssistantMessageInfo | { events: ProjectedEvent[] },
  ): ProjectedEvent[] {
    const out = "events" in infoOrEnsure ? infoOrEnsure.events : [];
    if (this.open) {
      out.push(this.partEvent(this.open));
      delete this.open;
    }
    return out;
  }

  private appendStreaming(kind: "text" | "reasoning", delta: string): ProjectedEvent[] {
    const ensured = this.ensureAssistant();
    const out = [...ensured.events];
    if (this.open && this.open.type !== kind) out.push(...this.closeOpen(ensured.info));
    let open = this.open;
    if (!open) {
      // 模型回合可能在工具轮后继续输出：若上一步已关（stepOpen=false），补开新回合。
      if (!this.stepOpen) {
        this.stepOpen = true;
        const step: MessageStepStartPart = {
          id: this.id("prt"),
          sessionId: this.sessionId,
          messageId: ensured.info.id,
          type: "step-start",
        };
        out.push({ type: "message.part.updated", properties: { part: step } });
      }
      const base = {
        id: this.id("prt"),
        sessionId: this.sessionId,
        messageId: ensured.info.id,
        text: "",
      };
      open = kind === "text" ? { ...base, type: "text" } : { ...base, type: "reasoning" };
      this.open = open;
      out.push(this.partEvent(open));
    }
    open.text += delta;
    out.push({
      type: "message.part.delta",
      properties: {
        sessionId: this.sessionId,
        messageId: open.messageId,
        partId: open.id,
        field: "text",
        delta,
      },
    });
    return out;
  }

  private newToolPart(callId: string, tool: string): MessageToolPart {
    const info = this.assistant;
    return {
      id: this.id("prt"),
      sessionId: this.sessionId,
      messageId: info?.id ?? this.id("msg"),
      type: "tool",
      callId,
      tool,
      state: { status: "pending", inputText: "" },
    };
  }
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
