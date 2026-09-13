import type { ReactNode } from "react";
import styles from "./memory.module.less";

export type MemoryData = Record<string, any>;

export const memoryRoutes = [
  ["overview", "Overview"], ["jobs", "Jobs"], ["sessions", "Indexed Sessions"],
  ["rollouts", "Rollout Memory"], ["phase2", "Phase 2"], ["logs", "Logs"],
] as const;

export function list(data: any, keys: string[]) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

export function value(data: any, keys: string[], fallback: any = "—") {
  for (const key of keys) if (data?.[key] !== undefined && data?.[key] !== null) return data[key];
  return fallback;
}

export function formatDate(input: any) {
  if (!input) return "—";
  const date = new Date(typeof input === "number" && input < 1e12 ? input * 1000 : input);
  return Number.isNaN(date.getTime()) ? String(input) : date.toLocaleString();
}

export function formatBytes(input: any) {
  const bytes = Number(input);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = "B";
  for (const candidate of units) { amount /= 1024; unit = candidate; if (amount < 1024) break; }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

export function Status({ children }: { children: ReactNode }) {
  const text = String(children ?? "unknown");
  const tone = /fail|error|dead|missing|unavailable|mismatch/i.test(text) ? styles.bad : /run|pending|queue|warn|partial|degrad|idle/i.test(text) ? styles.warn : /ok|ready|success|complete|done|active|available|published|consistent/i.test(text) ? styles.good : "";
  return <span className={`${styles.status} ${tone}`}>{text}</span>;
}

export function Notice({ data, always = false }: { data: any; always?: boolean }) {
  const availability = value(data, ["availability", "status"], data?.meta?.availability);
  const available = typeof data?.meta?.dbAvailable === "boolean"
    ? data.meta.dbAvailable
    : typeof availability === "object"
      ? availability?.available !== false
      : !/unavailable|error|failed/i.test(String(availability ?? "available"));
  const capabilitySource = value(data, ["capabilities"], data?.meta?.capabilities) ?? {};
  const capabilities = capabilitySource.features ?? capabilitySource;
  const entries = Object.entries(capabilities).filter(([, item]) => typeof item === "boolean");
  const missing = entries.filter(([, item]) => !item).map(([key]) => key);
  const diagnostics = list(data, ["diagnostics", "warnings"]).concat(list(data?.meta, ["diagnostics", "warnings"]));
  const healthy = available && !missing.length && !diagnostics.length;
  if (!always && healthy) return null;
  const details = [typeof availability === "object" ? availability?.reason : "", missing.length ? `Missing capabilities: ${missing.join(", ")}` : "", ...diagnostics.map(String)].filter(Boolean);
  return <aside className={`${styles.notice} ${healthy ? styles.noticeHealthy : ""}`}>
    <Status>{healthy ? "healthy" : available ? "degraded" : "unavailable"}</Status>
    <div><strong>{available ? "Database connected" : "Database unavailable"} · {entries.filter(([, enabled]) => enabled).length}/{entries.length} capabilities · {healthy ? "Schema healthy" : "Attention required"}</strong>
      {!!details.length && <details><summary>View diagnostics</summary>{details.map((detail, index) => <p key={index}>{detail}</p>)}</details>}
    </div>
  </aside>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className={styles.empty}>{children}</div>; }

export function Facts({ values }: { values: Record<string, ReactNode> }) {
  return <dl className={styles.facts}>{Object.entries(values).map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{item ?? "—"}</dd></div>)}</dl>;
}

export function Table({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  if (!rows.length) return <Empty>No data returned.</Empty>;
  return <div className={styles.tableWrap}><table><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
