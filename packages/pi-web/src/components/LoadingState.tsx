import styles from "./State.module.less";

export function LoadingState({ label = "Loading local data…" }: { label?: string }) {
  return <div className={styles.state} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><span>{label}</span></div>;
}
