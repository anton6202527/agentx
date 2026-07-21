/**
 * HTTP API 的形式化描述 —— 单一事实源（对齐 opencode 的「路由声明 → OpenAPI →
 * SDK」管线的第一环）。
 *
 *   - `ROUTES`：全部端点的类型化描述表。http-server 的实现与之对齐
 *     （api.test.ts 交叉校验），SDK 按它的形状封装。
 *   - `EVENTS`：SSE 事件目录（命名事件 + payload 说明）。
 *   - `generateOpenApi()`：零依赖生成 OpenAPI 3.1 文档，由 `GET /doc` 提供。
 *
 * SSE 信封统一为 `{ id, type, properties }`（首帧 server.connected，随后
 * session.snapshot，之后实时事件；每 30s 一条 server.heartbeat）。
 */

export interface RouteDef {
  method: "get" | "post" | "delete" | "patch";
  /** OpenAPI 风格路径，如 /sessions/{id}/send */
  path: string;
  summary: string;
  /** 请求体 schema（POST/PATCH；JSON object） */
  request?: Record<string, unknown>;
  /** 成功响应：204 表示无 body；schema 表示 200 JSON；"sse" 表示事件流 */
  response: Record<string, unknown> | 204 | "sse";
  tag: "global" | "session" | "message" | "permission";
}

const SESSION_SUMMARY = { $ref: "#/components/schemas/SessionSummary" };
const SESSION_SNAPSHOT = { $ref: "#/components/schemas/SessionSnapshot" };

export const ROUTES: RouteDef[] = [
  {
    method: "get",
    path: "/healthz",
    summary: "健康检查（兼容别名）",
    response: { type: "object" },
    tag: "global",
  },
  {
    method: "get",
    path: "/global/health",
    summary: "健康检查：服务名与协议版本",
    response: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        name: { type: "string" },
        protocol: { type: "integer" },
      },
    },
    tag: "global",
  },
  {
    method: "get",
    path: "/doc",
    summary: "本文档（OpenAPI 3.1）",
    response: { type: "object" },
    tag: "global",
  },
  {
    method: "get",
    path: "/sessions",
    summary: "列出会话",
    response: { type: "array", items: SESSION_SUMMARY },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions",
    summary: "创建会话",
    request: {
      type: "object",
      required: ["cwd", "model"],
      properties: { cwd: { type: "string" }, model: { type: "string" }, title: { type: "string" } },
    },
    response: SESSION_SUMMARY,
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}",
    summary: "读取会话快照（懒加载到内存）",
    response: SESSION_SNAPSHOT,
    tag: "session",
  },
  {
    method: "delete",
    path: "/sessions/{id}",
    summary: "删除会话（中断 live drive 并删盘）",
    response: 204,
    tag: "session",
  },
  {
    method: "patch",
    path: "/sessions/{id}",
    summary: "改会话标题",
    request: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    response: 204,
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}/events",
    summary: "订阅事件流（SSE 信封）",
    response: "sse",
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}/messages",
    summary: "读取消息（Message+Parts 投影）",
    response: { type: "array", items: { $ref: "#/components/schemas/MessageWithParts" } },
    tag: "message",
  },
  {
    method: "get",
    path: "/sessions/{id}/checkpoints",
    summary: "列出可撤销点",
    response: { type: "array", items: { $ref: "#/components/schemas/Checkpoint" } },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/send",
    summary: "发消息驱动 agent loop（drive 收尾后返回）",
    request: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" }, model: { type: "string" } },
    },
    response: 204,
    tag: "message",
  },
  {
    method: "post",
    path: "/sessions/{id}/interrupt",
    summary: "中断当前 drive",
    request: { type: "object" },
    response: 204,
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/undo",
    summary: "撤销到检查点（files/conversation/both）",
    request: {
      type: "object",
      properties: {
        checkpointId: { type: "string" },
        mode: { type: "string", enum: ["files", "conversation", "both"] },
      },
    },
    response: {
      type: "object",
      properties: {
        restored: { type: "integer" },
        deleted: { type: "integer" },
        removedMessages: { type: "integer" },
      },
    },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/compact",
    summary: "手动压缩上下文",
    request: { type: "object" },
    response: {
      type: "object",
      properties: {
        compacted: { type: "boolean" },
        beforeTokens: { type: "integer" },
        afterTokens: { type: "integer" },
      },
    },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/fork",
    summary: "复制会话历史为新会话",
    request: {
      type: "object",
      properties: { title: { type: "string" }, upToMessage: { type: "integer" } },
    },
    response: SESSION_SUMMARY,
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission",
    summary: "裁决权限请求（先到先得）",
    request: {
      type: "object",
      required: ["permId", "decision"],
      properties: {
        permId: { type: "string" },
        decision: { type: "string", enum: ["allow", "allow_remember", "allow_always", "deny"] },
      },
    },
    response: { type: "object", properties: { answered: { type: "boolean" } } },
    tag: "permission",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission-mode",
    summary: "切换权限模式",
    request: { type: "object", required: ["mode"], properties: { mode: { type: "string" } } },
    response: 204,
    tag: "permission",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission-profile",
    summary: "切换权限档位，返回生效模式",
    request: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    response: { type: "object", properties: { mode: { type: "string" } } },
    tag: "permission",
  },
  {
    method: "get",
    path: "/sessions/{id}/permission-profiles",
    summary: "列出可用权限档位",
    response: { type: "object" },
    tag: "permission",
  },
];

/** SSE 信封：data 行统一为该 JSON 形状（不再使用 SSE 的 event: 字段区分）。 */
export interface EventEnvelope {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

/** SSE 事件目录：type → payload 说明（写进 OpenAPI 的 x-events 供 SDK/文档消费）。 */
export const EVENTS: Record<string, string> = {
  "server.connected": "连接建立（保证为首帧）",
  "server.heartbeat": "心跳（约 30s 一条）",
  "session.snapshot": "订阅即回放的会话快照（properties = SessionSnapshot）",
  "session.event": "SessionEvent 原样透传（host 客户端兼容通道）：{ sessionId, event }",
  "session.status": "运行态变化：{ sessionId, running }",
  "session.updated": "标题等元数据变化：{ sessionId, title }",
  "session.reverted":
    "撤销完成：{ sessionId, checkpointId, restored, deleted, mode?, removedMessages? }",
  "permission.asked": "权限请求：{ sessionId, permId, toolName, ruleKey }",
  "permission.replied": "权限裁决：{ sessionId, permId, decision }",
  "message.updated": "消息元数据创建/完成：{ info: MessageInfo }",
  "message.part.updated": "part 创建或到达终态：{ part: MessagePart }",
  "message.part.delta": "流式增量：{ sessionId, messageId, partId, field: text|input, delta }",
};

/** 协议版本：信封或路由的不兼容变更时 +1。 */
export const PROTOCOL_VERSION = 1;

const COMPONENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  // 粗粒度 schema：形状以 core 的 TypeScript 类型为准（本表用于文档与 SDK 导航，
  // 不做运行时校验）。
  SessionSummary: {
    type: "object",
    required: ["id", "createdAt", "updatedAt", "cwd", "model", "running"],
    properties: {
      id: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      title: { type: "string" },
      running: { type: "boolean" },
    },
  },
  SessionSnapshot: {
    type: "object",
    required: ["meta", "messages", "usage", "running", "pendingPermissions"],
    properties: {
      meta: { type: "object" },
      messages: { type: "array", items: { type: "object" } },
      usage: { type: "object" },
      costUSD: { type: "number" },
      running: { type: "boolean" },
      pendingPermissions: { type: "array", items: { type: "object" } },
    },
  },
  Checkpoint: {
    type: "object",
    required: ["id", "tree", "label", "messageCount"],
    properties: {
      id: { type: "string" },
      tree: { type: "string" },
      label: { type: "string" },
      messageCount: { type: "integer" },
    },
  },
  MessageWithParts: {
    type: "object",
    required: ["info", "parts"],
    properties: {
      info: { type: "object" },
      parts: { type: "array", items: { $ref: "#/components/schemas/MessagePart" } },
    },
  },
  MessagePart: {
    type: "object",
    required: ["id", "sessionId", "messageId", "type"],
    properties: {
      id: { type: "string" },
      sessionId: { type: "string" },
      messageId: { type: "string" },
      type: {
        type: "string",
        enum: ["text", "reasoning", "file", "step-start", "step-finish", "tool"],
      },
    },
  },
  EventEnvelope: {
    type: "object",
    required: ["id", "type", "properties"],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: Object.keys(EVENTS) },
      properties: { type: "object" },
    },
  },
};

/** 生成 OpenAPI 3.1 文档（`GET /doc`）。 */
export function generateOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const op: Record<string, unknown> = {
      summary: route.summary,
      tags: [route.tag],
      ...(route.path.includes("{id}")
        ? {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          }
        : {}),
      ...(route.request
        ? { requestBody: { content: { "application/json": { schema: route.request } } } }
        : {}),
      responses:
        route.response === 204
          ? { "204": { description: "no content" } }
          : route.response === "sse"
            ? {
                "200": {
                  description: "SSE 事件流；每帧 data 为 EventEnvelope",
                  content: {
                    "text/event-stream": {
                      schema: { $ref: "#/components/schemas/EventEnvelope" },
                    },
                  },
                },
              }
            : {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: route.response } },
                },
              },
    };
    (paths[route.path] ??= {})[route.method] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "anicode server",
      version: `${PROTOCOL_VERSION}.0.0`,
      description:
        "AniCode server-first HTTP API。鉴权：可选 Bearer token（SSE 可用 ?token= 查询参数）。",
    },
    paths,
    components: { schemas: COMPONENT_SCHEMAS },
    "x-events": EVENTS,
  };
}
