import React from "react";
import type { SessionSummary } from "@anicode/core";

export type View = "chat" | "marketplace" | "settings";

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  view: View;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNavigate: (view: View) => void;
}

export function Sidebar({ sessions, currentId, view, onNew, onSelect, onDelete, onNavigate }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">◆ anicode</div>
        <button className="new-chat" onClick={onNew}>
          ＋ 新对话
        </button>
      </div>

      <nav className="sidebar-nav">
        <button className={`nav-item ${view === "chat" ? "active" : ""}`} onClick={() => onNavigate("chat")}>
          💬 对话
        </button>
        <button
          className={`nav-item ${view === "marketplace" ? "active" : ""}`}
          onClick={() => onNavigate("marketplace")}
        >
          🧩 插件市场
        </button>
        <button className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => onNavigate("settings")}>
          ⚙ 设置
        </button>
      </nav>

      <div className="sidebar-label">最近对话</div>
      <div className="session-list">
        {sessions.length === 0 ? <div className="session-empty">暂无对话</div> : null}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === currentId && view === "chat" ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
            title={`${s.model} · ${s.id}`}
          >
            <span className="session-title">{s.title ?? "未命名对话"}</span>
            {s.running ? <span className="session-dot" /> : null}
            <span className="session-model">{s.model}</span>
            <button
              className="session-del"
              title="删除对话"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
