import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ConversationFlow from "./ConversationFlow";
import type { ChatMessage } from "./types";
import styles from "./MessageList.module.less";

const FOLLOW_DISTANCE = 48;
const JUMP_BUTTON_DISTANCE = 250;
const CORRECTION_DELAYS = [80, 240] as const;

function distanceFromBottom(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function ConversationViewport({ children, updateToken }: { children: ReactNode; updateToken: unknown }) {
  const root = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const timers = useRef<Set<number>>(new Set());
  const [showJumpButton, setShowJumpButton] = useState(false);

  const cancelScheduledScrolls = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = root.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setShowJumpButton(false);
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    cancelScheduledScrolls();
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!following.current) return;
      scrollToBottom();
      CORRECTION_DELAYS.forEach((delay) => {
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          if (following.current) scrollToBottom();
        }, delay);
        timers.current.add(timer);
      });
    });
  }, [cancelScheduledScrolls, scrollToBottom]);

  useEffect(() => {
    if (following.current) scheduleScrollToBottom();
    return cancelScheduledScrolls;
  }, [updateToken, scheduleScrollToBottom, cancelScheduledScrolls]);

  return <div className={styles.viewport}>
    <div
      ref={root}
      className={styles.transcript}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      onScroll={(event) => {
        const distance = distanceFromBottom(event.currentTarget);
        following.current = distance <= FOLLOW_DISTANCE;
        setShowJumpButton(distance > JUMP_BUTTON_DISTANCE);
        if (!following.current) cancelScheduledScrolls();
      }}
    >
      {children}
    </div>
    {showJumpButton && <button
      type="button"
      className={styles.jumpToBottom}
      onClick={() => {
        following.current = true;
        setShowJumpButton(false);
        scheduleScrollToBottom();
      }}
    >
      <span aria-hidden="true">↓</span>
      滚动到底部
    </button>}
  </div>;
}

export function MessageList({ messages, scopeKey = "current-session" }: { messages: ChatMessage[]; scopeKey?: string }) {
  return <ConversationViewport updateToken={messages}>
    <ConversationFlow messages={messages} scopeKey={scopeKey} />
  </ConversationViewport>;
}

export default MessageList;
