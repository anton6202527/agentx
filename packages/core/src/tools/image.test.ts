import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTool } from "./fs.js";
import type { ToolContext } from "./tool.js";
import type { ImagePart } from "../types.js";

/** 最小合法 PNG（1x1），足以验证附图链路。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function ctx(cwd: string, opts: Partial<ToolContext> = {}): ToolContext {
  return { cwd, signal: new AbortController().signal, ...opts };
}

async function scratch(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("read 图片：模型支持视觉时附上图片本体", async () => {
  const dir = await scratch("anicode-img-ok-");
  await fs.writeFile(path.join(dir, "shot.png"), PNG_1X1);
  const images: ImagePart[] = [];
  const out = await readTool.run(
    { path: "shot.png" },
    ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
  );
  assert.equal(images.length, 1, "应附上一张图片");
  assert.equal(images[0]!.type, "image");
  assert.equal(images[0]!.mediaType, "image/png");
  assert.equal(images[0]!.data, PNG_1X1.toString("base64"), "应为图片的 base64 原文");
  assert.match(out, /shot\.png/);
  assert.doesNotMatch(out, /二进制|binary/i, "图片不应被当成二进制拒读");
});

test("read 图片：模型不支持视觉时降级为文本说明且不附图", async () => {
  const dir = await scratch("anicode-img-novision-");
  await fs.writeFile(path.join(dir, "shot.png"), PNG_1X1);
  const images: ImagePart[] = [];
  const out = await readTool.run(
    { path: "shot.png" },
    ctx(dir, { modelSupportsImages: false, attachImage: (i) => images.push(i) }),
  );
  assert.equal(images.length, 0, "不支持视觉时绝不能附图（会被 provider 拒绝整轮请求）");
  assert.match(out, /shot\.png/);
});

test("read 图片：缺少 attachImage 能力时安全降级", async () => {
  const dir = await scratch("anicode-img-nocb-");
  await fs.writeFile(path.join(dir, "shot.png"), PNG_1X1);
  // modelSupportsImages 为 true 但宿主没提供 attachImage —— 不应抛错
  const out = await readTool.run({ path: "shot.png" }, ctx(dir, { modelSupportsImages: true }));
  assert.match(out, /shot\.png/);
});

test("read 图片：超出大小上限时不附图并说明原因", async () => {
  const dir = await scratch("anicode-img-big-");
  // 必须是"魔数合法但超大"，否则会先被魔数校验挡下，测不到大小分支
  await fs.writeFile(
    path.join(dir, "huge.png"),
    Buffer.concat([PNG_1X1, Buffer.alloc(4_000_000, 1)]),
  );
  const images: ImagePart[] = [];
  const out = await readTool.run(
    { path: "huge.png" },
    ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
  );
  assert.equal(images.length, 0, "超限图片不应附上");
  assert.match(out, /huge\.png/);
  assert.match(out, /上限|too large/, "应说明是大小超限，而非其他原因");
});

/** 各类型的最小合法头部（魔数校验要求内容与后缀一致）。 */
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)]);
const GIF_HEAD = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
const WEBP_HEAD = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(4),
]);

test("read 图片：jpg/gif/webp 后缀映射到正确 mediaType", async () => {
  const dir = await scratch("anicode-img-types-");
  const cases: [string, Buffer, string][] = [
    ["a.jpg", JPEG_HEAD, "image/jpeg"],
    ["b.jpeg", JPEG_HEAD, "image/jpeg"],
    ["c.gif", GIF_HEAD, "image/gif"],
    ["d.webp", WEBP_HEAD, "image/webp"],
  ];
  for (const [name, bytes, expected] of cases) {
    await fs.writeFile(path.join(dir, name), bytes);
    const images: ImagePart[] = [];
    await readTool.run(
      { path: name },
      ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
    );
    assert.equal(images[0]?.mediaType, expected, `${name} 应映射为 ${expected}`);
  }
});

test("回归：后缀是图片但内容不是，绝不附图（否则整轮请求被 provider 拒）", async () => {
  const dir = await scratch("anicode-img-fake-");
  // 文本文件被命名成 .png —— 后缀是可控数据，不能当事实
  await fs.writeFile(path.join(dir, "notes.png"), "这其实是一段文本，不是 PNG\n");
  const images: ImagePart[] = [];
  const out = await readTool.run(
    { path: "notes.png" },
    ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
  );
  assert.equal(images.length, 0, "非法图片内容绝不能被附上");
  assert.match(out, /notes\.png/);
  assert.match(out, /不是合法|not a valid/, "应说明后缀与内容不符");
});

test("回归：合法 GIF/WEBP 魔数校验通过", async () => {
  const dir = await scratch("anicode-img-magic-");
  // GIF89a 头
  await fs.writeFile(
    path.join(dir, "a.gif"),
    Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]),
  );
  // RIFF....WEBP 头
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    Buffer.alloc(4),
  ]);
  await fs.writeFile(path.join(dir, "b.webp"), webp);
  for (const [name, mt] of [
    ["a.gif", "image/gif"],
    ["b.webp", "image/webp"],
  ] as const) {
    const images: ImagePart[] = [];
    await readTool.run(
      { path: name },
      ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
    );
    assert.equal(images[0]?.mediaType, mt, `${name} 合法魔数应通过校验并附图`);
  }
});

test("read 普通文本文件不受附图链路影响", async () => {
  const dir = await scratch("anicode-img-text-");
  await fs.writeFile(path.join(dir, "a.ts"), "const x = 1\n");
  const images: ImagePart[] = [];
  const out = await readTool.run(
    { path: "a.ts" },
    ctx(dir, { modelSupportsImages: true, attachImage: (i) => images.push(i) }),
  );
  assert.equal(images.length, 0);
  assert.match(out, /const x = 1/);
});
