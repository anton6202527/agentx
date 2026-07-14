# agentx

自研 AI coding agent 的正式代码库（monorepo）。技术栈：**TypeScript (Node/Bun) · Ink (TUI) · Electron (App 壳，阶段二)**。

```
packages/
  core/     # Agent Core（无头内核）✅ provider 抽象层 + 工具集 + 权限 + Agent loop
  tui/      # Ink 终端界面 ✅ 接 core 事件流
  app/      # Electron 桌面版（阶段二，待建）
```

## 进度（2026-07-13）

三层全部打通，10 个测试全绿，全仓类型检查 0 错误——**且全程未用任何真实 API key**（靠脚本化假 provider + 本地假 SSE 服务器验证）。

### 1. Provider 抽象层（`core/src/provider`、`types.ts`）
统一消息模型（内容块数组）+ 流式事件通道 + registry。`AnthropicProvider` 和 `OpenAICompatProvider`（覆盖 OpenAI/Ollama/DeepSeek/vLLM/OpenRouter）。BYOK，密钥只读环境变量。

### 2. 工具集（`core/src/tools`）
`read / write / edit / glob / grep / bash`。要点：
- 所有路径经 `resolveInside()` 强制约束在 cwd 内（沙箱边界，防目录穿越）
- `edit` 要求 old_string 唯一，否则报错（对齐 Claude Code 语义）
- `bash` 带超时 + abort kill；`glob/grep` 自绕过 node_modules/.git
- 每个工具自带 `readOnly` 标记和 `ruleKey()`，供权限引擎决策，无需硬编码工具名

### 3. 权限系统（`core/src/permission.ts`）
UI 无关。决策链：`bypass` → 只读工具 → allowRules（支持 `Bash(git *)` glob）→ `auto` → confirm 回调。`confirm` 是 core 与前端的唯一耦合点。支持"允许并记住"。

### 4. Agent loop（`core/src/agent.ts`）
把 provider + tools + permission 编织成循环，对外只暴露 `send(text) → AsyncGenerator<AgentEvent>`。事件流（`text/thinking/tool_start/tool_permission/tool_result/turn_end/done/error`）是 core 与所有前端的唯一契约。

### 5. Ink TUI（`tui/src/app.tsx`）
只做三件事：渲染事件流、收集输入、实现权限 confirm（把授权请求变成 y/a/n 交互）。用 `<Static>` 渲染已完成条目滚进终端历史，下方渲染实时流式文本。核心桥接：core 的异步 `confirm` 回调 → React state 上的 pending 请求 → 键盘 resolve。

## 跑起来

```bash
npm install
npm run typecheck            # 全仓，0 错误

# 单测（无需 API key）
cd packages/core && npm test # 8 个：registry/映射/agent loop/权限
cd packages/tui  && node --import tsx --test 'src/**/*.test.tsx'  # 2 个：TUI 键入→授权→渲染

# 真实运行 TUI（需配 key，或本地起 Ollama）
export ANTHROPIC_API_KEY=sk-...
cd packages/tui
npm start -- --model anthropic/claude-opus-4-8
npm start -- --model openai/gpt-5.2 --auto
npm start -- --model ollama/qwen3 --cwd /some/project
```

## 验证覆盖

| 层 | 测试方式 | 结果 |
|---|---|---|
| provider registry / 消息结构 | 单测 | ✅ |
| OpenAI 兼容层全链路 | 本地假 SSE 服务器（分片工具参数、tool_result 线格式、usage 映射） | ✅ |
| Agent loop | 脚本化 provider：工具执行 / 权限拒绝 / 只读放行 / 收尾 | ✅ |
| TUI 端到端 | ink-testing-library：键入→授权弹窗→批准→文件落盘→渲染 | ✅ |

## 底层加固（2026-07-13，Fable 5 第二轮）

逐文件复审 provider / compaction / 历史一致性 / 沙箱 / 存储，修复 5 处会造成 400、安全逃逸、成本浪费的真实缺陷：

| 缺陷 | 后果 | 修复 |
|---|---|---|
| Anthropic 只缓存 system，**对话历史无缓存断点** | 多轮 agent 每轮全价重算历史前缀（最大的成本漏洞） | 双断点：system（连带 tools）+ 最后一条消息（缓存对话前缀）；`buildAnthropicRequest` 抽成纯函数并用测试钉死断点位置 |
| compaction 切割点可能落在 tool_result 上 | 保留窗口以孤儿 tool_result 开头 → provider 回放 **400** | `findSafeCutoff`：切割点必须是纯文本 user 消息；找不到则放弃压缩 |
| 崩溃后 resume 历史以悬空 tool_call 结尾 | 下一次 send 必 **400** | `repairHistory` 自愈：补合成错误 tool_result 并落盘 |
| 沙箱可被符号链接逃逸 | cwd 内一个指向外部的 symlink 即可读写任意文件 | `resolveInside` 加 realpath 校验（含新建文件的父链解析） |
| `SessionStore.rewrite` 非原子 | compaction 重写中崩溃 → 会话文件损坏 | tmp + rename 原子写 |

新增 12 个测试（缓存断点放置 ×4、compaction 边界 ×2、历史自愈 ×1、沙箱逃逸 ×5）。

---

## 架构重构（2026-07-13，Fable 5）

用更强的模型重审了此前实现，发现并修复了几处**真正的架构缺陷**，把底层重做成产品级：

### 核心弱点 → 修复

| 旧问题 | 影响 | 现在 |
|---|---|---|
| daemon 的 `(live as any).__bindWrite` hack | 两连接驱动同一会话会互相覆盖，**破坏"共享会话/接管"** | 删除；改 pub/sub 广播 |
| 事件只流向发起 send 的连接 | 第二个观察者什么都收不到 | subscribe 广播给**所有**订阅者 |
| 无 subscribe/snapshot | 晚加入/重连拿不到状态 | open 立即回放 snapshot |
| Agent `send` 可重入 | history 被并发破坏 | busy 护栏，重入抛错 |
| `.bind(this) as any`、错位字段 | 类型 hack | 全部消除，`strict` 通过 |

### 拱心石：`SessionHost` 接口 + pub/sub 总线

- **`SessionManager`**（`core/src/session-manager.ts`）：每个会话一个广播源。`send` 驱动 Agent，事件广播给所有订阅者；权限请求作为会话事件广播，任一订阅者可裁决（permId = 工具调用 id，供 UI 关联）；`open` 立即回放 transcript+running 快照。
- **`SessionHost`**（`core/src/host.ts`）：前端唯一面对的契约。两个等价实现——`LocalSessionHost`(进程内)和 `DaemonClient=RemoteSessionHost`(跨进程 socket)。**前端对传输无关,正如 core 对 UI 无关。**
- daemon 变成 SessionManager 之上极薄的 socket 转发层,`server.ts` 从 ~200 行降到 ~120 行,逻辑全下沉到 manager——因此本地和远程行为天然一致。

**验证**:daemon 测试真跑双客户端订阅同一会话,一个 send、另一个(纯观察)也收到完整事件流 + 权限广播;起独立 daemon 进程,RemoteSessionHost 跨进程建会话/订阅/列表全通。

### TUI 接 SessionHost + 会话命令

- `app.tsx` 只依赖 `SessionHost`,`cli.tsx` 默认 `LocalSessionHost`、`--daemon` 切 `RemoteSessionHost`,零改动 App。
- 斜杠命令:`/sessions` 列会话 · `/resume <id>` 载入并**回显历史 transcript**续接 · `/new [标题]` · `/exit`。
- `transcript.ts` 的 `messagesToItems` 把 snapshot.messages 还原成界面条目(resume 回显靠它)。

---

## M2→M3 已完成（2026-07-13）

四块全部实现并测试，全仓 **21 个测试全绿、0 类型错误**，仍旧全程无真实 API key。

### 上下文管理（`core/src/context.ts`）
- **项目记忆**：从 cwd 向上逐级收集 `AGENTS.md`/`CLAUDE.md`，止于 `.git` 边界，就近优先拼进 system 提示
- **Compaction**：历史 token 估算超阈值时，把旧轮经 summarizer 压成一段摘要 + 保留最近 N 轮；summarizer 可注入（生产用小模型，测试用假实现，故可离线测）
- 已集成进 Agent，每轮 provider 调用前自动检查

### 会话持久化 + resume（`core/src/session.ts`）
- `SessionStore`：每会话一个 JSONL 文件，meta 头行 + 逐条消息追加写（长会话不卡）
- Agent 支持 `persistence`：每轮自动 append，compaction 后整文件 rewrite；`resumeMessages` 载入续接不重复写

### 守护进程 / client-server（`core/src/daemon/`）
- NDJSON over unix socket。`DaemonServer` 持有 Agent 实例，`DaemonClient` 供前端连接
- **权限经协议回流**：core 的 confirm → `permission_request` 帧 → 客户端裁决 → 回传
- 一个 daemon 可被 CLI + App 同时连，共享会话（App 阶段的复用基础）
- 独立进程可跑：`npm run daemon --workspace @agentx/core`

### MCP 客户端（`core/src/mcp.ts`）
- 自研最小 stdio 客户端：JSON-RPC 2.0 + Content-Length 分帧，支持 initialize / tools.list / tools.call
- 每个 MCP 工具包装成 core `Tool`（命名 `<server>__<tool>`，默认非只读走权限门），可直接挂进 Agent
- 无外部依赖，用假 MCP server 脚本离线测试真实协议往返

## 测试总览（38 全绿，0 类型错误，全程无真实 API key）

| 包 | 测试数 | 覆盖 |
|---|---|---|
| core | 35 | provider 映射 + **缓存断点放置** / agent loop + 并发护栏 + **历史自愈** / 权限 / 上下文记忆 + **compaction 安全边界** / 会话持久化+resume / SessionManager 多订阅广播 / daemon 双客户端共享会话 / MCP 协议往返 / **沙箱逃逸（穿越+symlink）** |
| tui | 3 | 键入→授权→落盘→渲染（走 SessionHost）/ /resume 回显历史 / /sessions 列会话 |

## 运行

```bash
npm install && npm run typecheck

# TUI —— 进程内（默认）
cd packages/tui && export ANTHROPIC_API_KEY=sk-...
npm start -- --model anthropic/claude-opus-4-8
npm start -- --resume <sessionId>            # 续接已有会话

# TUI —— 连 daemon（跨进程共享会话）
npm run daemon --workspace @agentx/core &     # 起守护进程
npm start -- --daemon --model openai/gpt-5.2  # 另开 N 个前端连同一 daemon
```

## 下一步（阶段二）

1. `core`: Skills 目录约定（SKILL.md）+ Hooks + Subagents
2. `core`: 真沙箱（macOS seatbelt / Linux landlock）替换 bash 的原型级隔离
3. `app`: Electron 壳复用 daemon（`RemoteSessionHost`）—— 多 agent worktree 并行、Review 队列、项目管理层。**接口已就绪,App 与 CLI 用同一个 `SessionHost`。**
