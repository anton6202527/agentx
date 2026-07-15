/**
 * 从会话消息里的 write/edit tool_call 参数算出一次文件改动预览（纯函数，可离线测）。
 * write → 把写入内容当作全新增；edit → old_string vs new_string 的行级 diff。
 */

import type { ChatMessage } from "@anicode/core";
import { diffLines, diffStat, type DiffLine } from "@anicode/shared";
import type { FileChange } from "./protocol.js";

const MAX_LINES = 200;

export function fileChangeFor(messages: readonly ChatMessage[], toolId: string): FileChange | null {
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type !== "tool_call" || part.id !== toolId) continue;
      const args = part.args;
      const path = String(args["path"] ?? "");
      if (!path) return null;

      let lines: DiffLine[];
      let kind: "write" | "edit";
      if (part.name === "write") {
        kind = "write";
        lines = diffLines("", String(args["content"] ?? ""));
      } else if (part.name === "edit") {
        kind = "edit";
        lines = diffLines(String(args["old_string"] ?? ""), String(args["new_string"] ?? ""));
      } else {
        return null;
      }

      const { added, removed } = diffStat(lines);
      const truncated = lines.length > MAX_LINES;
      return {
        toolId,
        path,
        kind,
        added,
        removed,
        lines: truncated ? lines.slice(0, MAX_LINES) : lines,
        ...(truncated ? { truncated: true } : {}),
      };
    }
  }
  return null;
}
