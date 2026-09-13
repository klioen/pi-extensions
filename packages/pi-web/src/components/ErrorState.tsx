import styles from "./State.module.less";

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className={`${styles.state} ${styles.error}`} role="alert"><strong>Request failed</strong><p>{message}</p>{onRetry && <button className="button" type="button" onClick={onRetry}>Retry</button>}</div>;
}
