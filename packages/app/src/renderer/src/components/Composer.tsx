import React, { useLayoutEffect, useRef, useState } from "react";

interface Props {
  running: boolean;
  modelLabel: string;
  disabled?: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenModelPicker: () => void;
}

export function Composer({ running, modelLabel, disabled, onSend, onInterrupt, onOpenModelPicker }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 随内容自动增高（上限由 CSS max-height 控制，超出后内部滚动），对齐 ChatGPT。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送；Shift+Enter 换行（对齐 ChatGPT）。
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder="给 anicode 发消息…（Enter 发送，Shift+Enter 换行）"
          value={text}
          disabled={disabled}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
          <button className="model-chip" onClick={onOpenModelPicker} title="切换模型">
            {modelLabel} ▾
          </button>
          {running ? (
            <button className="send-btn stop" onClick={onInterrupt} title="中断">■</button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={disabled || !text.trim()} title="发送">↑</button>
          )}
        </div>
      </div>
      <div className="composer-hint">anicode 可能出错；重要操作会请求授权。</div>
    </div>
  );
}
