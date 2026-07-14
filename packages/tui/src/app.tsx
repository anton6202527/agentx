/**
 * App —— Ink 前端，只依赖 SessionHost 接口（本地 or daemon 一视同仁）。
 *
 * 职责：订阅当前会话的事件流并渲染；收集输入（含 /斜杠命令）；把权限请求
 * 变成 y/a/n 交互回 answerPermission。会话逻辑全在 core，App 不碰。
 *
 * 斜杠命令：/sessions 列会话 · /resume <id> 载入续接 · /new [标题] 新会话 · /exit
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import type { SessionHost, SessionEvent, SessionSummary, Usage } from "@agentx/core";
import { messagesToItems, firstLine, truncate, type Item } from "./transcript.js";

interface State {
  items: Item[];
  liveText: string;
  running: boolean;
  usage: Usage;
  toolIndex: Map<string, number>;
}

type Action =
  | { t: "reset"; items: Item[]; usage: Usage; running: boolean }
  | { t: "push"; item: Item }
  | { t: "live"; delta: string }
  | { t: "flushLive" }
  | { t: "toolStart"; id: string; name: string; ruleKey: string }
  | { t: "toolStatus"; id: string; status: "ok" | "err" | "deny"; detail?: string }
  | { t: "running"; v: boolean }
  | { t: "usage"; u: Usage };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "reset":
      return { items: a.items, liveText: "", running: a.running, usage: a.usage, toolIndex: new Map() };
    case "push":
      return { ...s, items: [...s.items, a.item] };
    case "live":
      return { ...s, liveText: s.liveText + a.delta };
    case "flushLive":
      if (!s.liveText) return s;
      return { ...s, items: [...s.items, { kind: "assistant", text: s.liveText }], liveText: "" };
    case "toolStart": {
      const idx = s.items.length;
      const toolIndex = new Map(s.toolIndex).set(a.id, idx);
      return { ...s, items: [...s.items, { kind: "tool", name: a.name, ruleKey: a.ruleKey, status: "run" }], toolIndex };
    }
    case "toolStatus": {
      const idx = s.toolIndex.get(a.id);
      if (idx == null) return s;
      const items = s.items.slice();
      const cur = items[idx] as Extract<Item, { kind: "tool" }>;
      items[idx] = { ...cur, status: a.status, ...(a.detail ? { detail: a.detail } : {}) };
      return { ...s, items };
    }
    case "running":
      return { ...s, running: a.v };
    case "usage":
      return { ...s, usage: a.u };
  }
}

const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface PendingPerm {
  permId: string;
  toolName: string;
  ruleKey: string;
}

export interface AppProps {
  host: SessionHost;
  cwd: string;
  model: string;
  sessionId: string;
}

export function App({ host, cwd, model, sessionId: initialId }: AppProps) {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(initialId);
  const [state, dispatch] = useReducer(reducer, {
    items: [{ kind: "info", text: `agentx · ${model} · ${cwd}` }, { kind: "info", text: "/sessions 列会话 · /resume <id> · /new [标题] · /exit" }],
    liveText: "",
    running: false,
    usage: emptyUsage,
    toolIndex: new Map(),
  });
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingPerm | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  // 订阅当前会话：载入 snapshot → 渲染，之后实时收事件
  useEffect(() => {
    let closed = false;
    closeRef.current?.();
    void host
      .open(sessionId, (ev) => handleEvent(ev, dispatch, setPending))
      .then((handle) => {
        if (closed) {
          handle.close();
          return;
        }
        closeRef.current = handle.close;
        const snap = handle.snapshot;
        dispatch({ t: "reset", items: messagesToItems(snap.messages), usage: snap.usage, running: snap.running });
      })
      .catch((err) => dispatch({ t: "push", item: { kind: "error", text: String(err.message) } }));
    return () => {
      closed = true;
      closeRef.current?.();
      closeRef.current = null;
    };
  }, [host, sessionId]);

  const runSlash = useCallback(
    async (line: string): Promise<boolean> => {
      const [cmd, ...rest] = line.slice(1).split(" ");
      if (cmd === "exit" || cmd === "quit") {
        exit();
        return true;
      }
      if (cmd === "sessions") {
        const list = await host.listSessions();
        setSessions(list);
        return true;
      }
      if (cmd === "resume") {
        const id = rest[0];
        if (!id) {
          dispatch({ t: "push", item: { kind: "error", text: "用法: /resume <sessionId>" } });
          return true;
        }
        setSessions(null);
        setSessionId(id); // 触发 useEffect 重新订阅
        return true;
      }
      if (cmd === "new") {
        const title = rest.join(" ") || undefined;
        const meta = await host.createSession({ cwd, model, ...(title ? { title } : {}) });
        setSessions(null);
        setSessionId(meta.id);
        return true;
      }
      dispatch({ t: "push", item: { kind: "error", text: `未知命令: /${cmd}` } });
      return true;
    },
    [host, cwd, model, exit],
  );

  useInput((ch, key) => {
    if (pending) {
      const kind = ch === "y" || ch === "Y" ? "allow" : ch === "a" || ch === "A" ? "allow_remember" : "deny";
      void host.answerPermission(sessionId, pending.permId, kind);
      setPending(null);
      return;
    }
    if (state.running) {
      if (key.escape) void host.interrupt(sessionId);
      return;
    }
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (!text) return;
      if (text.startsWith("/")) {
        void runSlash(text);
        return;
      }
      dispatch({ t: "push", item: { kind: "user", text } });
      dispatch({ t: "running", v: true });
      void host.send(sessionId, text).catch((err) =>
        dispatch({ t: "push", item: { kind: "error", text: String(err.message) } }),
      );
    } else if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((s) => s + ch);
    }
  });

  const u = state.usage;
  return (
    <Box flexDirection="column">
      <Static items={state.items}>{(item, i) => <ItemView key={i} item={item} />}</Static>

      {state.liveText ? (
        <Box>
          <Text color="green">● </Text>
          <Text>{state.liveText}</Text>
        </Box>
      ) : null}

      {sessions ? <SessionList sessions={sessions} /> : null}

      {pending ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">⚠ 授权请求: <Text bold>{pending.toolName}</Text></Text>
          <Text dimColor>{truncate(pending.ruleKey, 100)}</Text>
          <Text>[<Text color="green">y</Text>] 允许 [<Text color="cyan">a</Text>] 允许并记住 [<Text color="red">n</Text>] 拒绝</Text>
        </Box>
      ) : null}

      {!pending && (
        <Box>
          {state.running ? (
            <Text dimColor>… 工作中（Esc 中断）</Text>
          ) : (
            <Text><Text color="green">❯ </Text>{input}<Text inverse> </Text></Text>
          )}
        </Box>
      )}

      <Box>
        <Text dimColor>{`会话 ${sessionId.slice(0, 10)}… · in ${u.inputTokens} (cache ${u.cacheReadTokens}) / out ${u.outputTokens} tokens`}</Text>
      </Box>
    </Box>
  );
}

function handleEvent(
  se: SessionEvent,
  dispatch: React.Dispatch<Action>,
  setPending: (p: PendingPerm | null) => void,
) {
  if (se.type === "state") {
    dispatch({ t: "running", v: se.running });
    if (!se.running) dispatch({ t: "flushLive" });
    return;
  }
  if (se.type === "permission_request") {
    setPending({ permId: se.permId, toolName: se.toolName, ruleKey: se.ruleKey });
    return;
  }
  // se.type === "agent"
  const ev = se.event;
  switch (ev.type) {
    case "text":
      dispatch({ t: "live", delta: ev.text });
      break;
    case "thinking":
      break;
    case "tool_start":
      dispatch({ t: "flushLive" });
      dispatch({ t: "toolStart", id: ev.id, name: ev.name, ruleKey: ev.ruleKey });
      break;
    case "tool_permission":
      if (ev.decision === "deny") dispatch({ t: "toolStatus", id: ev.id, status: "deny" });
      break;
    case "tool_result":
      dispatch({ t: "toolStatus", id: ev.id, status: ev.isError ? "err" : "ok", detail: firstLine(ev.content) });
      break;
    case "turn_end":
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "compacted":
      dispatch({ t: "push", item: { kind: "info", text: `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens` } });
      break;
    case "done":
      dispatch({ t: "flushLive" });
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "error":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "error", text: ev.message } });
      break;
  }
}

function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>会话列表（/resume &lt;id&gt; 载入）</Text>
      {sessions.length === 0 ? <Text dimColor>（暂无会话）</Text> : null}
      {sessions.slice(0, 10).map((s) => (
        <Text key={s.id}>
          <Text color="green">{s.id}</Text>
          {s.running ? <Text color="yellow"> ●运行中</Text> : null}
          <Text dimColor> {s.title ?? "(无标题)"} · {s.model}</Text>
        </Text>
      ))}
    </Box>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "info":
      return <Text dimColor>{item.text}</Text>;
    case "user":
      return <Box><Text color="blue" bold>❯ </Text><Text>{item.text}</Text></Box>;
    case "assistant":
      return <Box><Text color="green">● </Text><Text>{item.text}</Text></Box>;
    case "tool": {
      const mark = item.status === "run" ? "⚙" : item.status === "ok" ? "✔" : item.status === "deny" ? "⊘" : "✖";
      const color = item.status === "ok" ? "cyan" : item.status === "err" ? "red" : item.status === "deny" ? "yellow" : "gray";
      return (
        <Box>
          <Text color={color as never}>  {mark} </Text>
          <Text bold>{item.name}</Text>
          <Text dimColor> {truncate(item.ruleKey, 50)}</Text>
          {item.detail ? <Text dimColor> — {item.detail}</Text> : null}
        </Box>
      );
    }
    case "error":
      return <Text color="red">✖ {item.text}</Text>;
  }
}
