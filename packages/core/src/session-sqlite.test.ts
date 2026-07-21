import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteSessionStore, sqliteAvailable } from "./session-sqlite.js";
import { SessionStore } from "./session.js";
import type { ChatMessage } from "./types.js";

const available = await sqliteAvailable();
const opts = { skip: available ? false : "node:sqlite 不可用（旧 Node 运行时）" };

const msg = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });

test("SqliteSessionStore: 与 JSONL 等价的 CRUD 语义", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    const meta = await store.create({ id: "s_a_1", cwd: dir, model: "m", title: "标题" });
    assert.equal(meta.createdAt, meta.updatedAt);
    assert.equal(meta.title, "标题");

    await store.append("s_a_1", msg("一"));
    await store.append("s_a_1", msg("二"));
    const loaded = await store.load("s_a_1");
    assert.equal(loaded.messages.length, 2);
    assert.equal((loaded.messages[1]!.content[0] as { text: string }).text, "二");

    // append 推进 updated_at
    const list1 = await store.list();
    assert.equal(list1.length, 1);
    assert.equal(list1[0]!.id, "s_a_1");

    // rewrite 覆盖历史
    await store.rewrite({ ...meta }, [msg("只剩这条")]);
    const after = await store.load("s_a_1");
    assert.equal(after.messages.length, 1);
    assert.equal((after.messages[0]!.content[0] as { text: string }).text, "只剩这条");

    // 删除级联清消息
    await store.delete("s_a_1");
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => store.load("s_a_1"));
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: list 按 updated_at 倒序", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    await store.create({ id: "s_a_1", cwd: dir, model: "m" });
    await new Promise((r) => setTimeout(r, 5));
    await store.create({ id: "s_b_2", cwd: dir, model: "m" });
    await new Promise((r) => setTimeout(r, 5));
    await store.append("s_a_1", msg("bump")); // s_a_1 变最新
    const list = await store.list();
    assert.equal(list[0]!.id, "s_a_1");
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: importFrom 从 JSONL 迁移且幂等", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const jsonl = new SessionStore(path.join(dir, "sessions"));
  await jsonl.create({ id: "s_j_1", cwd: dir, model: "m", title: "旧会话" });
  await jsonl.append("s_j_1", msg("历史一"));
  await jsonl.append("s_j_1", msg("历史二"));

  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    assert.equal(await store.importFrom(jsonl), 1);
    assert.equal(await store.importFrom(jsonl), 0); // 幂等
    const loaded = await store.load("s_j_1");
    assert.equal(loaded.title, "旧会话");
    assert.equal(loaded.messages.length, 2);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
