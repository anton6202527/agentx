import { test } from "node:test";
import assert from "node:assert/strict";
import { createTodoTool, type TodoItem } from "./todo.js";

function context(events: unknown[] = []) {
  return {
    cwd: "/tmp/project",
    signal: new AbortController().signal,
    emit: (event: unknown) => events.push(event),
  };
}

test("todo_write: 每次调用整表替换，并上报最新清单进度", async () => {
  const tool = createTodoTool();
  const events: unknown[] = [];
  const initial: TodoItem[] = [
    { content: "inspect", status: "completed" },
    { content: "implement", status: "in_progress", activeForm: "implementing" },
  ];

  const first = await tool.run({ todos: initial }, context(events));
  assert.equal(first, "清单已更新：共 2 项，未完成 1 项");
  assert.deepEqual(tool.todos, initial);
  assert.deepEqual(events, [{ type: "todos", todos: initial }]);

  const replacement: TodoItem[] = [{ content: "verify", status: "pending" }];
  const second = await tool.run({ todos: replacement }, context(events));
  assert.equal(second, "清单已更新：共 1 项，未完成 1 项");
  assert.deepEqual(tool.todos, replacement);
  assert.deepEqual(events[1], { type: "todos", todos: replacement });
});

test("todo_write: 拒绝非数组、缺少 content 和非法 status", async () => {
  const tool = createTodoTool();

  await assert.rejects(() => tool.run({ todos: "nope" }, context()), /todos 必须是数组/);
  await assert.rejects(
    () => tool.run({ todos: [{ status: "pending" }] }, context()),
    /任务项缺少 content/,
  );
  await assert.rejects(
    () => tool.run({ todos: [{ content: "bad", status: "paused" }] }, context()),
    /非法 status: paused/,
  );
});

test("todo_write: 状态写工具明确禁止并发执行", () => {
  const tool = createTodoTool();

  assert.equal(tool.isConcurrencySafe?.({ todos: [] }), false);
});
