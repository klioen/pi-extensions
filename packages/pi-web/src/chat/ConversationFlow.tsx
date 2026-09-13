import { useEffect, useId, useMemo, useRef, useState } from "react";
import MarkdownMessage from "./MarkdownMessage";
import styles from "./ConversationFlow.module.less";

export interface ConversationMessage {
  id?: string;
  role: string;
  text?: string;
  timestamp?: string | number;
  status?: string;
  toolName?: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
}

type FlowItem =
  | { type: "message"; key: string; message: ConversationMessage }
  | { type: "reasoning"; key: string; message: ConversationMessage }
  | { type: "tools"; key: string; messages: ConversationMessage[] };

const ACTIVE_TOOL_STATUSES = new Set(["sending", "accepted", "queued", "running", "streaming"]);

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ""); }
}

function timestampDisplay(timestamp: string | number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { label: String(timestamp) };
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date),
  };
}

export function groupConversationMessages(messages: ConversationMessage[]): FlowItem[] {
  const items: FlowItem[] = [];
  let tools: ConversationMessage[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    items.push({ type: "tools", key: `tools-${tools[0]?.id ?? items.length}`, messages: tools });
    tools = [];
  };

  let reasoningIndex = 0;
  messages.forEach((message, index) => {
    const role = message.role.toLowerCase();
    const toolName = message.toolName?.toLowerCase();
    if (role === "reasoning" || role === "thinking" || (role === "tool" && toolName === "thinking")) {
      flushTools();
      items.push({ type: "reasoning", key: `reasoning-${reasoningIndex++}`, message });
      return;
    }
    if (role === "tool") {
      tools.push(message);
      return;
    }
    flushTools();
    items.push({ type: "message", key: message.id ?? `message-${index}`, message });
  });
  flushTools();
  return items;
}

function Reasoning({ message }: { message: ConversationMessage }) {
  const running = message.status !== undefined && ACTIVE_TOOL_STATUSES.has(message.status);
  const [expanded, setExpanded] = useState(running);
  const contentId = useId();
  const wasRunning = useRef(running);
  const userControlled = useRef(false);

  useEffect(() => {
    if (running || wasRunning.current !== running) {
      setExpanded(running);
      userControlled.current = false;
    } else if (!userControlled.current && !message.text) {
      setExpanded(false);
    }
    wasRunning.current = running;
  }, [message.text, running]);

  const label = running ? "思考中" : "思考过程";
  return <section className={`${styles.reasoning} ${expanded ? styles.reasoningExpanded : ""}`} data-role="reasoning">
    <button type="button" className={styles.reasoningToggle} aria-expanded={expanded} aria-controls={contentId} onClick={() => { userControlled.current = true; setExpanded((value) => !value); }}>
      <span className={`${styles.reasoningMark} ${running ? styles.reasoningMarkRunning : ""}`} aria-hidden="true">✦</span>
      <span>{label}</span>
      <span className={styles.chevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {expanded && <div className={styles.reasoningContent} id={contentId}><MarkdownMessage>{message.text || "…"}</MarkdownMessage></div>}
  </section>;
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  return <details className={styles.toolData}>
    <summary>{label}</summary>
    <pre>{printable(value)}</pre>
  </details>;
}

export function ToolExecutionGroup({ messages }: { messages: ConversationMessage[] }) {
  const running = messages.some((message) => message.status !== undefined && ACTIVE_TOOL_STATUSES.has(message.status));
  const failed = messages.some((message) => message.status === "error" || message.status === "failed" || Boolean(message.error));
  const [expanded, setExpanded] = useState(running);
  const detailsId = useId();

  useEffect(() => {
    setExpanded(running);
  }, [running]);

  const title = running ? "正在执行" : "执行过程";
  const summary = failed ? "部分步骤失败" : running ? `${messages.length} 个步骤进行中` : `${messages.length} 个步骤已完成`;

  return <section className={`${styles.toolGroup} ${expanded ? styles.toolGroupExpanded : ""}`}>
    <button
      type="button"
      className={styles.toolSummary}
      aria-expanded={expanded}
      aria-controls={detailsId}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className={`${styles.toolMark} ${running ? styles.toolMarkRunning : ""}`} aria-hidden="true">⌁</span>
      <span className={styles.toolTitle}>{title}</span>
      <span className={failed ? styles.toolFailed : styles.toolMeta}>{summary}</span>
      <span className={styles.chevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button>
    {expanded && <div className={styles.toolSteps} id={detailsId}>
      {messages.map((message, index) => <div className={styles.toolStep} key={message.id ?? index}>
        <div className={styles.toolStepHeader}>
          <span className={`${styles.stepDot} ${ACTIVE_TOOL_STATUSES.has(message.status ?? "") ? styles.stepDotRunning : ""} ${message.status === "error" || message.status === "failed" || message.error ? styles.stepDotFailed : ""}`} aria-hidden="true" />
          <strong>{message.toolName || "Tool"}</strong>
          <span>{message.status || (running ? "running" : "done")}</span>
        </div>
        {message.arguments !== undefined && <ToolPayload label="Arguments" value={message.arguments} />}
        {(message.error !== undefined || message.result !== undefined) && <ToolPayload label={message.error ? "Error" : "Result"} value={message.error ?? message.result} />}
      </div>)}
    </div>}
  </section>;
}

function Message({ message }: { message: ConversationMessage }) {
  const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
  const text = message.text || (message.status === "streaming" ? "…" : "");
  const timestamp = message.timestamp === undefined ? undefined : timestampDisplay(message.timestamp);
  const queued = message.status === "queued";

  return <article data-message-id={message.id} data-role={role} className={`${styles.message} ${styles[role]}`} tabIndex={timestamp ? 0 : undefined}>
    <div className={styles.body}>{role === "assistant" ? <MarkdownMessage>{text}</MarkdownMessage> : text}</div>
    {message.error && <div className={styles.messageError} role="alert">{message.error}</div>}
    {(timestamp || queued) && <div className={styles.messageMeta}>
      {queued && <span>queued</span>}
      {timestamp && <time dateTime={timestamp.dateTime}>{timestamp.label}</time>}
    </div>}
  </article>;
}

export function ConversationFlow({ messages, className = "", scopeKey = "conversation" }: { messages: ConversationMessage[]; className?: string; scopeKey?: string }) {
  const items = useMemo(() => groupConversationMessages(messages), [messages]);
  return <div className={`${styles.flow} ${className}`.trim()}>
    {items.map((item) => item.type === "tools"
      ? <ToolExecutionGroup key={`${scopeKey}:${item.key}`} messages={item.messages} />
      : item.type === "reasoning"
        ? <Reasoning key={`${scopeKey}:${item.key}`} message={item.message} />
        : <Message key={item.key} message={item.message} />)}
  </div>;
}

export default ConversationFlow;
