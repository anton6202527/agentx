/**
 * transcript 数据模型 + 从 ChatMessage[] 重建条目的纯函数。
 * resume / 晚加入订阅时，用 snapshot.messages 还原界面靠它。
 */

import type { ChatMessage } from "@agentx/core";

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; ruleKey: string; status: "run" | "ok" | "err" | "deny"; detail?: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

/** 把持久化的消息历史渲染成 transcript 条目（用于 resume 回显） */
export function messagesToItems(messages: readonly ChatMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text") {
        if (m.role === "user") items.push({ kind: "user", text: part.text });
        else items.push({ kind: "assistant", text: part.text });
      } else if (part.type === "tool_call") {
        items.push({
          kind: "tool",
          name: part.name,
          ruleKey: ruleKeyOf(part.name, part.args),
          status: "ok", // 历史里的调用视为已完成
        });
      } else if (part.type === "tool_result" && part.isError) {
        // 错误结果附到最近一条 tool 上
        const last = [...items].reverse().find((i) => i.kind === "tool") as
          | Extract<Item, { kind: "tool" }>
          | undefined;
        if (last) {
          last.status = "err";
          last.detail = firstLine(part.content);
        }
      }
    }
  }
  return items;
}

function ruleKeyOf(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return String(args["command"] ?? "");
  return String(args["path"] ?? args["pattern"] ?? JSON.stringify(args).slice(0, 60));
}

export function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
