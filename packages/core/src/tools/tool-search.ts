/**
 * tool_search —— deferred 工具的检索/激活入口（对齐 Codex 的 MCP tool search、
 * Claude Code 的 ToolSearch）。
 *
 * 大量工具（主要是 MCP）以 deferred 注册时，schema 不进请求；模型需要某能力时
 * 先 tool_search 关键词检索，命中的工具被激活，下一轮起即可直接调用。
 * 支持 "select:name1,name2" 精确选取。
 */

import { t } from "../i18n.js";
import { ToolError, ToolRegistry, type Tool } from "./tool.js";
import type { ToolDefinition } from "../types.js";

const DEFAULT_MAX = 5;

function score(def: ToolDefinition, terms: string[]): number {
  const hay = `${def.name} ${def.description ?? ""}`.toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (!term) continue;
    if (def.name.toLowerCase().includes(term))
      s += 3; // 名字命中权重更高
    else if (hay.includes(term)) s += 1;
  }
  return s;
}

export function createToolSearchTool(registry: ToolRegistry): Tool {
  return {
    def: {
      name: "tool_search",
      description: t(
        "Search deferred tools by keywords and activate them. Some tools (mostly MCP) are " +
          'hidden until searched: call this with keywords (e.g. "slack send message") or ' +
          '"select:tool_a,tool_b" for exact names. Activated tools become callable from the ' +
          "next turn. Returns the matched tools' names and descriptions.",
        "按关键词检索并激活延迟暴露的工具。部分工具（主要是 MCP）默认隐藏：用关键词" +
          '（如 "slack 发消息"）或 "select:tool_a,tool_b" 精确选取。激活后下一轮即可直接调用。' +
          "返回命中工具的名称与说明。",
      ),
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: t(
              'Keywords, or "select:name1,name2" for exact tool names',
              '关键词；或 "select:name1,name2" 按名字精确选取',
            ),
          },
          max_results: {
            type: "number",
            description: t(
              `Max tools to activate (default ${DEFAULT_MAX})`,
              `最多激活数（默认 ${DEFAULT_MAX}）`,
            ),
          },
        },
        required: ["query"],
      },
    },
    readOnly: true,
    // 激活会改变后续请求的工具面——不与其他调用并发，避免同轮竞态。
    isConcurrencySafe: () => false,
    ruleKey: (input) => String(input.query ?? ""),
    async run(input) {
      const query = String(input.query ?? "").trim();
      if (!query) throw new ToolError(t("query is required", "query 不能为空"));
      const max = Math.max(1, Math.min(20, Number(input.max_results) || DEFAULT_MAX));
      const deferred = registry.deferredDefinitions();
      if (deferred.length === 0) {
        return t(
          "No deferred tools remain; every tool is already exposed.",
          "没有待激活的延迟工具；当前全部工具均已暴露。",
        );
      }

      let picked: ToolDefinition[];
      if (query.toLowerCase().startsWith("select:")) {
        const wanted = query
          .slice("select:".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        picked = deferred.filter((d) => wanted.includes(d.name));
        const missing = wanted.filter((w) => !picked.some((d) => d.name === w));
        if (picked.length === 0) {
          throw new ToolError(
            t(
              `No deferred tool matches: ${wanted.join(", ")}. Available: ${deferred.map((d) => d.name).join(", ")}`,
              `没有匹配的延迟工具: ${wanted.join(", ")}。可选: ${deferred.map((d) => d.name).join(", ")}`,
            ),
          );
        }
        if (missing.length > 0) {
          // 部分命中：激活命中的，明确报出缺失的。
          for (const def of picked) registry.activate(def.name);
          return (
            formatActivated(picked) +
            "\n" +
            t(`Not found: ${missing.join(", ")}`, `未找到: ${missing.join(", ")}`)
          );
        }
      } else {
        const terms = query.toLowerCase().split(/\s+/);
        picked = deferred
          .map((def) => ({ def, s: score(def, terms) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, max)
          .map((x) => x.def);
        if (picked.length === 0) {
          return t(
            `No deferred tool matches "${query}". Available: ${deferred.map((d) => d.name).join(", ")}`,
            `没有与 "${query}" 匹配的延迟工具。可选: ${deferred.map((d) => d.name).join(", ")}`,
          );
        }
      }

      for (const def of picked) registry.activate(def.name);
      return formatActivated(picked);
    },
  };
}

function formatActivated(defs: ToolDefinition[]): string {
  const lines = defs.map((d) => `- ${d.name}: ${(d.description ?? "").slice(0, 200)}`);
  return (
    t(
      `Activated ${defs.length} tool(s) — callable from the next turn:`,
      `已激活 ${defs.length} 个工具——下一轮起可直接调用：`,
    ) +
    "\n" +
    lines.join("\n")
  );
}
