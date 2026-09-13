import type { ReactNode } from "react";
import styles from "./view.module.less";

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className={styles.header}><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className={styles.actions}>{actions}</div>}</header>;
}

export function LoadingState({ label = "Loading local data…" }: { label?: string }) {
  return <div className={styles.state} role="status">{label}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className={`${styles.state} ${styles.error}`} role="alert"><strong>Request failed</strong><span>{error instanceof Error ? error.message : String(error)}</span>{retry && <button type="button" onClick={retry}>Retry</button>}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.state}><strong>No data</strong><span>{children}</span></div>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "info" }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

export function DefinitionList({ values }: { values: Record<string, unknown> }) {
  return <dl className={styles.definitions}>{Object.entries(values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>)}</dl>;
}

export function formatDate(value: unknown) {
  if (!value) return "—";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : String(value));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "—";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export { styles as sharedStyles };
