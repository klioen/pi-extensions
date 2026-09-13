import { useState } from "react";
import Composer from "./Composer";
import MessageList from "./MessageList";
import { useChatRuntime } from "./useChatRuntime";
import type { ChatRuntimeOptions } from "./runtime";
import styles from "./ChatPage.module.less";

export function ChatPage({ runtimeOptions = {} }: { runtimeOptions?: Omit<ChatRuntimeOptions, "onChange"> }) {
  const { state, send, abort, retry } = useChatRuntime(runtimeOptions);
  const [actionError, setActionError] = useState("");
  const unavailable = state.phase === "unavailable";
  const disconnected = state.phase === "loading" || !state.connected;
  const running = Boolean(state.activeRun?.runId);
  const connectionLabel = unavailable
    ? "Runtime 不可用"
    : state.phase === "error"
      ? "连接失败"
      : state.connected
        ? "已连接"
        : "正在连接";
  const runLabel = running ? `运行中 · ${state.activeRun?.state || "running"}` : "空闲";
  const sessionName = state.snapshot?.sessionName || "当前 Session";
  const isLoading = state.phase === "loading";
  const isEmpty = state.phase === "ready" && state.messages.length === 0;
  const composer = !unavailable && !isLoading && <Composer
    variant={isEmpty ? "hero" : "compact"}
    disabled={disconnected}
    running={running}
    onSend={async (text) => { setActionError(""); await send(text); }}
    onStop={async () => { setActionError(""); await abort(); }}
    onError={(error) => setActionError(error.message)}
  />;

  return <section className={styles.workbench} aria-label="Current session chat">
    <header className={styles.subheader} aria-label="对话状态">
      <div className={styles.session}>
        <strong>{sessionName}</strong>
        <span className={styles.sessionId}>{state.sessionId || "Local agent access"}</span>
      </div>
      <div className={styles.runtime} role="status">
        <span className={`${styles.connection} ${state.connected ? styles.connected : styles.disconnected}`}>
          {connectionLabel}
        </span>
        {!unavailable && <span>{runLabel}</span>}
        {(state.error || actionError) && <span className={styles.error}>{actionError || state.error}</span>}
        {state.phase === "error" && <button type="button" onClick={() => void retry()}>重试</button>}
      </div>
    </header>
    {isLoading ? <div className={styles.skeleton} aria-label="正在加载对话" role="status">
      <span /><span /><span />
    </div> : unavailable ? <div className={styles.unavailable}>
      <div className={styles.mark} aria-hidden="true">π</div>
      <h2>当前没有可用的 Pi Session</h2>
      <p>请先在 Pi 中打开一个 Session，然后返回此处继续对话。</p>
    </div> : isEmpty ? <div className={styles.empty}>
      <div className={styles.welcome}>
        <div className={styles.mark} aria-hidden="true">π</div>
        <h2>和当前 Pi Session 对话</h2>
        <p>消息会进入本地 agent runtime，运行时可继续发送 follow-up。</p>
      </div>
      {composer}
    </div> : <>
      <MessageList messages={state.messages} scopeKey={state.sessionId || "current-session"} />
      {composer && <div className={styles.composerDock}>{composer}</div>}
    </>}
  </section>;
}

export default ChatPage;
