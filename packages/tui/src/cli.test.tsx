import { test } from "node:test";
import assert from "node:assert/strict";
import { registerOpenAICompatibleProvider, type SessionHost } from "@agentx/core";
import {
  parseArgs,
  resolveConfiguredProvider,
  selectSessionId,
  validateArgs,
} from "./cli.js";

test("CLI: --daemon --resume 只传递会话 ID，不预先 open", async () => {
  let createCalls = 0;
  const host: Pick<SessionHost, "createSession"> = {
    async createSession() {
      createCalls++;
      throw new Error("resume 不应创建会话");
    },
  };
  const args = parseArgs(["--daemon", "--resume", "session-existing"]);

  assert.equal(await selectSessionId(host, args), "session-existing");
  assert.equal(createCalls, 0);
});

test("CLI: 非 resume 路径只创建一次会话", async () => {
  let createCalls = 0;
  const host: Pick<SessionHost, "createSession"> = {
    async createSession(input) {
      createCalls++;
      assert.equal(input.cwd, "/work");
      assert.equal(input.model, "openai/gpt-test");
      return {
        id: "session-new",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        cwd: input.cwd,
        model: input.model,
        running: false,
      };
    },
  };
  const args = parseArgs(["--cwd", "/work", "--model", "openai/gpt-test"]);

  assert.equal(await selectSessionId(host, args), "session-new");
  assert.equal(createCalls, 1);
});

test("CLI: daemon 客户端拒绝静默忽略权限模式", () => {
  for (const flag of ["--auto", "--accept-edits"]) {
    const args = parseArgs(["--daemon", flag]);
    assert.throws(
      () => validateArgs(args),
      new RegExp(`${flag}.*daemon 进程.*不会被当前连接修改`),
    );
  }

  assert.doesNotThrow(() => validateArgs(parseArgs(["--daemon"])));
  assert.doesNotThrow(() => validateArgs(parseArgs(["--auto"])));
});

test("CLI: 严格拒绝未知参数、缺值与互斥参数", () => {
  assert.throws(() => parseArgs(["--wat"]), /未知参数: --wat/);
  assert.throws(() => parseArgs(["--model"]), /--model 需要一个值/);
  assert.throws(() => parseArgs(["--model", "--auto"]), /--model 需要一个值/);
  assert.throws(() => parseArgs(["--cwd"]), /--cwd 需要一个值/);
  assert.throws(() => parseArgs(["--auto", "--accept-edits"]), /不能同时使用/);
  assert.throws(() => parseArgs(["--demo", "--model", "openai/gpt-test"]), /不能同时使用/);
  assert.throws(() => parseArgs(["--resume", "one", "--resume", "two"]), /不能重复指定/);
});

test("CLI: demo 与隔离会话目录适合零配置本地调试", () => {
  const args = parseArgs([
    "--demo",
    "--cwd",
    "/work",
    "--sessions",
    "/tmp/agentx-test-sessions",
    "--debug-log",
    "/tmp/agentx-test.jsonl",
  ]);

  assert.equal(args.model, "debug/demo");
  assert.equal(args.cwd, "/work");
  assert.equal(args.sessionsDir, "/tmp/agentx-test-sessions");
  assert.equal(args.debugLog, "/tmp/agentx-test.jsonl");
  assert.doesNotThrow(() => validateArgs(args));
});

test("CLI: daemon 拒绝本地专属会话目录，trace 必须配日志", () => {
  assert.throws(
    () => validateArgs(parseArgs(["--daemon", "--sessions", "/tmp/sessions"])),
    /会话目录由 daemon 管理/,
  );
  assert.throws(
    () => validateArgs(parseArgs(["--trace-content"])),
    /必须与 --debug-log 一起使用/,
  );
});

test("CLI: 本地 resolver 在建会话时给出缺凭证诊断，debug 始终可用", () => {
  const envName = "AGENTX_CLI_TEST_KEY";
  const previous = process.env[envName];
  delete process.env[envName];
  registerOpenAICompatibleProvider({
    id: "cli-missing-key-test",
    baseURL: "https://example.invalid/v1",
    apiKeyEnv: envName,
    requiresApiKey: true,
  });
  try {
    assert.throws(
      () => resolveConfiguredProvider("cli-missing-key-test/model"),
      new RegExp(`缺少凭证.*${envName}.*--demo`),
    );
    assert.equal(resolveConfiguredProvider("debug/demo").provider.name, "debug");
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});
