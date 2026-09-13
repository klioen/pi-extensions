import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import styles from "./Composer.module.less";

interface ComposerProps {
  disabled?: boolean;
  running?: boolean;
  variant?: "hero" | "compact";
  onSend: (text: string) => Promise<unknown> | unknown;
  onStop: () => Promise<unknown> | unknown;
  onError?: (error: Error) => void;
}

export function Composer({ disabled = false, running = false, variant = "compact", onSend, onStop, onError }: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || disabled || busy) return;
    const draft = text;
    setBusy(true);
    try {
      await onSend(draft);
      setText("");
      queueMicrotask(resize);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      setText(draft);
      onError?.(error);
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  };
  const stop = async () => {
    if (!running || disabled || busy) return;
    setBusy(true);
    try { await onStop(); }
    catch (caught) { onError?.(caught instanceof Error ? caught : new Error(String(caught))); }
    finally { setBusy(false); }
  };
  const hasDraft = Boolean(text.trim());
  const stopsRun = running && !hasDraft;
  const primaryAction = async (event?: FormEvent) => {
    event?.preventDefault();
    if (stopsRun) await stop();
    else await submit();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void primaryAction();
    }
  };

  const actionLabel = stopsRun
    ? (busy ? "停止中…" : "Stop")
    : (busy ? "发送中…" : running ? "发送 follow-up" : "发送");

  return <form className={`${styles.composer} ${styles[variant]}`} data-variant={variant} onSubmit={primaryAction}>
    <label className={styles.srOnly} htmlFor="chat-input">发送消息</label>
    <textarea
      ref={textarea}
      id="chat-input"
      rows={1}
      placeholder="发送消息给当前 Pi Session…"
      value={text}
      disabled={disabled}
      onChange={(event) => { setText(event.target.value); resize(); }}
      onKeyDown={keyDown}
    />
    <div className={styles.footer}>
      <span className={styles.hint}>Enter 发送 · Shift+Enter 换行</span>
      <button
        className={`${styles.action} ${stopsRun ? styles.danger : styles.primary}`}
        type="submit"
        disabled={disabled || busy || (!running && !hasDraft)}
      >{actionLabel}</button>
    </div>
  </form>;
}

export default Composer;
