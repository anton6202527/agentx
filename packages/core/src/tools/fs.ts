/**
 * 文件系统工具：Read / Write / Edit / Glob / Grep。
 * 所有路径经 resolveInside() 强制约束在 cwd 内 —— 沙箱边界，防目录穿越。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";

/**
 * 把 model 给的路径解析为绝对路径，并确保**真实落点**在 cwd 内。
 * 两层校验：
 *   1. 字面路径前缀检查（挡 ../ 穿越）
 *   2. realpath 检查（挡符号链接逃逸 —— cwd 内一个指向外部的 symlink
 *      能骗过纯字符串检查，必须解析到真实文件系统位置再比对）
 * 对尚不存在的路径（write 新文件），realpath 其最深的已存在祖先目录。
 */
async function resolveInside(cwd: string, p: unknown): Promise<string> {
  if (typeof p !== "string" || !p) throw new ToolError("path 必须是非空字符串");
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolError(`路径越界，禁止访问 cwd 之外: ${p}`);
  }

  const realRoot = await fs.realpath(root);
  // 找最深的已存在祖先并 realpath 它（新文件场景 abs 本身可能不存在）
  let probe = abs;
  let suffix = "";
  while (true) {
    try {
      const real = await fs.realpath(probe);
      const realTarget = suffix ? path.join(real, suffix) : real;
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new ToolError(`路径越界（经符号链接指向 cwd 之外）: ${p}`);
      }
      return realTarget;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new ToolError(`无法解析路径: ${p}`);
      suffix = suffix ? path.join(path.basename(probe), suffix) : path.basename(probe);
      probe = parent;
    }
  }
}

function rel(cwd: string, abs: string): string {
  return path.relative(cwd, abs) || ".";
}

function ensureActive(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new ToolError("会话已中断，文件操作未执行");
}

export const readTool: Tool = {
  readOnly: true,
  def: {
    name: "read",
    description: "读取文件内容，返回带行号的文本。可选 offset/limit 分段读取大文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 cwd 的文件路径" },
        offset: { type: "number", description: "起始行（1 起，默认 1）" },
        limit: { type: "number", description: "最多读取行数（默认 2000）" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx: ToolContext) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e: any) {
      throw new ToolError(`读取失败: ${e?.code ?? e?.message ?? e}`);
    }
    const lines = content.split("\n");
    const offset = Math.max(1, Number(input["offset"] ?? 1));
    const limit = Math.max(1, Number(input["limit"] ?? 2000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) return `(文件 ${rel(ctx.cwd, abs)} 在该范围内为空)`;
    const width = String(offset + slice.length - 1).length;
    return slice
      .map((l, i) => `${String(offset + i).padStart(width)}\t${l}`)
      .join("\n");
  },
};

export const writeTool: Tool = {
  readOnly: false,
  mutatesFiles: true,
  def: {
    name: "write",
    description: "创建或完全覆盖一个文件。父目录会自动创建。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 cwd 的文件路径" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    const content = String(input["content"] ?? "");
    ensureActive(ctx);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    ensureActive(ctx);
    await fs.writeFile(abs, content, "utf8");
    return `已写入 ${rel(ctx.cwd, abs)}（${content.length} 字符）`;
  },
};

export const editTool: Tool = {
  readOnly: false,
  mutatesFiles: true,
  def: {
    name: "edit",
    description:
      "在文件中做精确字符串替换。old_string 必须在文件中唯一出现（否则报错），除非 replace_all=true。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 cwd 的文件路径" },
        old_string: { type: "string", description: "要替换的原文（需唯一）" },
        new_string: { type: "string", description: "替换后的内容" },
        replace_all: { type: "boolean", description: "替换全部出现（默认 false）" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    const oldStr = String(input["old_string"] ?? "");
    const newStr = String(input["new_string"] ?? "");
    const replaceAll = Boolean(input["replace_all"]);
    if (!oldStr) throw new ToolError("old_string 不能为空");

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e: any) {
      throw new ToolError(`读取失败: ${e?.code ?? e}`);
    }

    const { updated, replaced, mode } = applyEdit(content, oldStr, newStr, replaceAll);
    ensureActive(ctx);
    await fs.writeFile(abs, updated, "utf8");
    // mode=fuzzy 时提示模型这次靠空白容差匹配上了，下次可给更精确的 old_string。
    const note = mode === "fuzzy" ? "（按空白容差匹配）" : "";
    return `已修改 ${rel(ctx.cwd, abs)}（替换 ${replaced} 处${note ? " " + note : ""}）`;
  },
};

/**
 * 应用一次编辑：先精确匹配，失败再退到「按行去除首尾空白」的模糊匹配。
 * 都失败则抛出带「最接近片段」的反射式错误，让模型据此自我纠正（Aider 的关键经验：
 * 关掉这类自愈会让编辑错误率数倍上升）。
 */
export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): { updated: string; replaced: number; mode: "exact" | "fuzzy" } {
  const exact = content.split(oldStr).length - 1;
  if (exact === 1 || (exact > 1 && replaceAll)) {
    const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    return { updated, replaced: replaceAll ? exact : 1, mode: "exact" };
  }
  if (exact > 1 && !replaceAll) {
    throw new ToolError(`old_string 出现 ${exact} 次，不唯一；请扩大上下文（多带几行）或用 replace_all`);
  }

  // exact === 0：按行去空白模糊定位。
  const spans = locateFuzzy(content, oldStr);
  if (spans.length === 1 || (spans.length > 1 && replaceAll)) {
    // 从后往前替换，避免前面的替换改动后续 span 的偏移。
    let updated = content;
    const targets = replaceAll ? [...spans].reverse() : [spans[0]!];
    for (const s of targets) updated = updated.slice(0, s.start) + newStr + updated.slice(s.end);
    return { updated, replaced: targets.length, mode: "fuzzy" };
  }
  if (spans.length > 1 && !replaceAll) {
    throw new ToolError(
      `old_string 按空白容差匹配到 ${spans.length} 处，不唯一；请扩大上下文或用 replace_all`,
    );
  }

  const near = nearestSnippet(content, oldStr);
  throw new ToolError(
    "未找到 old_string（精确与空白容差均未命中）。" +
      (near
        ? `\n文件中最接近的片段是：\n<<<<<<<\n${near}\n>>>>>>>\n请据此修正 old_string 后重试。`
        : "请确认路径与内容，或先用 read 查看当前文件。"),
  );
}

/** 按行匹配：忽略每行首尾空白；返回命中在原文中的字符区间（保留原始缩进作被替换段）。 */
function locateFuzzy(content: string, oldStr: string): { start: number; end: number }[] {
  const oldLines = oldStr.split("\n").map((l) => l.trim());
  const lines = content.split("\n");
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1; // +1 为换行符
  }
  const n = oldLines.length;
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (lines[i + j]!.trim() !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = i + n - 1;
      spans.push({ start: offsets[i]!, end: offsets[last]! + lines[last]!.length });
    }
  }
  return spans;
}

/** 找出与 old_string 首行最相似的行，返回其起始的等长窗口，供反射式错误展示。 */
function nearestSnippet(content: string, oldStr: string): string | null {
  const anchor = oldStr.split("\n").map((l) => l.trim()).find(Boolean);
  if (!anchor) return null;
  const lines = content.split("\n");
  const n = oldStr.split("\n").length;
  let best = { sim: 0, i: 0 };
  for (let i = 0; i < lines.length; i++) {
    const sim = diceSimilarity(lines[i]!.trim(), anchor);
    if (sim > best.sim) best = { sim, i };
  }
  if (best.sim < 0.4) return null; // 太不相似就别误导模型
  return lines.slice(best.i, best.i + n).join("\n");
}

/** Sørensen–Dice 二元组相似度（0~1），用于"你是不是想找这段"的模糊定位。 */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, count] of ga) overlap += Math.min(count, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// ---------- Glob ----------

export const globTool: Tool = {
  readOnly: true,
  def: {
    name: "glob",
    description: "按 glob 模式查找文件（如 **/*.ts）。返回相对路径列表，按修改时间倒序。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式，如 src/**/*.ts" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["pattern"] ?? ""),
  async run(input, ctx) {
    const pattern = String(input["pattern"] ?? "");
    const matches: { path: string; mtime: number }[] = [];
    const root = path.resolve(ctx.cwd);
    await walk(root, root, globToRegExp(pattern), matches, ctx.signal);
    matches.sort((a, b) => b.mtime - a.mtime);
    if (matches.length === 0) return `(无文件匹配 ${pattern})`;
    return matches
      .slice(0, 200)
      .map((m) => path.relative(root, m.path))
      .join("\n");
  },
};

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  out: { path: string; mtime: number }[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue;
      await walk(root, abs, re, out, signal);
    } else if (e.isFile()) {
      const relPath = path.relative(root, abs);
      if (re.test(relPath)) {
        try {
          const st = await fs.stat(abs);
          out.push({ path: abs, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  // 支持 **（跨目录）、*（单层）、? （单字符）
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // **/ 吞掉斜杠
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// ---------- Grep ----------

export const grepTool: Tool = {
  readOnly: true,
  def: {
    name: "grep",
    description: "在文件内容中用正则搜索。返回 文件:行号:内容。可选 glob 限定文件范围。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        glob: { type: "string", description: "限定搜索的文件 glob（默认全部文本文件）" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["pattern"] ?? ""),
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(input["pattern"] ?? ""));
    } catch (e: any) {
      throw new ToolError(`无效正则: ${e?.message ?? e}`);
    }
    const root = path.resolve(ctx.cwd);
    const fileRe = input["glob"] ? globToRegExp(String(input["glob"])) : /.*/;
    const files: { path: string; mtime: number }[] = [];
    await walk(root, root, fileRe, files, ctx.signal);

    const results: string[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) break;
      let text: string;
      try {
        text = await fs.readFile(f.path, "utf8");
      } catch {
        continue; // 跳过二进制/不可读
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          results.push(`${path.relative(root, f.path)}:${i + 1}:${lines[i]!.slice(0, 200)}`);
          if (results.length >= 200) break;
        }
      }
      if (results.length >= 200) break;
    }
    if (results.length === 0) return `(无匹配 /${input["pattern"]}/)`;
    return results.join("\n");
  },
};
