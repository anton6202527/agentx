import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeatbeltProfile, wrapWithSandbox, resolveSandboxPolicy } from "./sandbox.js";

test("sandbox: workspace-write 只放行工作区+临时目录写入并断网", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: "/proj/app" });
  assert.match(p, /\(allow default\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/proj\/app"\)\)/);
  assert.match(p, /\(deny network\*\)/);
});

test("sandbox: read-only 不放行工作区写入", () => {
  const p = buildSeatbeltProfile({ policy: "read-only", cwd: "/proj/app" });
  assert.doesNotMatch(p, /subpath "\/proj\/app"/);
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /subpath "\/dev"/); // 仍允许写 /dev
});

test("sandbox: network=true 时不加断网规则", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: "/x", network: true });
  assert.doesNotMatch(p, /deny network/);
});

test("sandbox: 路径含引号被转义，避免 SBPL 注入", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: '/a"b' });
  assert.match(p, /subpath "\/a\\"b"/);
});

test("sandbox: wrapWithSandbox 在 macOS 包 sandbox-exec，其它平台/none 返回 null", () => {
  const mac = wrapWithSandbox("echo hi", { policy: "workspace-write", cwd: "/p" }, "darwin");
  assert.ok(mac);
  assert.equal(mac!.file, "sandbox-exec");
  assert.deepEqual(mac!.args.slice(-3), ["/bin/bash", "-c", "echo hi"]);

  assert.equal(wrapWithSandbox("echo hi", { policy: "workspace-write", cwd: "/p" }, "linux"), null);
  assert.equal(wrapWithSandbox("echo hi", { policy: "none", cwd: "/p" }, "darwin"), null);
});

test("sandbox: resolveSandboxPolicy 显式优先，其次环境变量，默认 none", () => {
  assert.equal(resolveSandboxPolicy("read-only", {}), "read-only");
  assert.equal(resolveSandboxPolicy(undefined, { AGENTX_BASH_SANDBOX: "workspace-write" }), "workspace-write");
  assert.equal(resolveSandboxPolicy(undefined, {}), "none");
  assert.equal(resolveSandboxPolicy("none", { AGENTX_BASH_SANDBOX: "read-only" }), "read-only");
});
