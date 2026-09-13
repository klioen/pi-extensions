import { useEffect, useRef, useState } from "react";
import styles from "./ConversationFlow.module.less";

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(value); return true; }
  catch { return false; }
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const resetTimer = useRef<number>();
  useEffect(() => () => { if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current); }, []);

  return <div className={styles.codeBlock}>
    <div className={styles.codeHeader}>
      <span>{language || "code"}</span>
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => void copyText(code).then((copied) => {
          setCopyState(copied ? "copied" : "unavailable");
          if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
          resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1600);
        })}
      >
        {copyState === "copied" ? "Copied" : copyState === "unavailable" ? "Copy unavailable" : "Copy"}
      </button>
    </div>
    <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
  </div>;
}

export default CodeBlock;
