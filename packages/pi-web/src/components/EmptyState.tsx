import type { ReactNode } from "react";
import styles from "./State.module.less";

export function EmptyState({ title = "No data", description, action }: { title?: string; description?: ReactNode; action?: ReactNode }) {
  return <div className={styles.state}><span className={styles.symbol} aria-hidden="true">◇</span><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}
