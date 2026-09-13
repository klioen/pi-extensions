import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import styles from "./DiskUsagePage.module.less";

type SortKey = "name" | "type" | "size" | "modified";
type SortOrder = "asc" | "desc";

interface DiskItem {
  name: string;
  relativePath: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  modifiedAt?: string;
  percent?: number;
  canDrillDown?: boolean;
}

interface DiskResult {
  current?: { relativePath?: string };
  breadcrumbs?: Array<{ name: string; relativePath: string }>;
  parent?: string | null;
  totalSize?: number;
  fileCount?: number;
  directoryCount?: number;
  scannedAt?: string;
  durationMs?: number;
  items?: DiskItem[];
  entries?: DiskItem[];
  diagnostics?: unknown[];
  partial?: boolean;
}

function formatBytes(value: unknown) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let amount = bytes;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatDate(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function diskHref(path = "") {
  const encoded = path.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return encoded ? `/disk/${encoded}` : "/disk";
}

function parentOf(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").slice(0, -1).join("/");
}

export default function DiskUsagePage() {
  const routePath = useParams()["*"] ?? "";
  const [sort, setSort] = useState<SortKey>("size");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshRequested = useRef(false);
  const generation = useRef(0);
  const [data, setData] = useState<DiskResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const current = () => generation.current === requestGeneration;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ sort, order });
    if (routePath) query.set("path", routePath);
    if (refreshRequested.current) {
      query.set("refresh", "1");
      refreshRequested.current = false;
    }
    try {
      const result = await api<DiskResult>(`/api/disk-usage?${query}`);
      if (current()) setData(result);
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (current()) setLoading(false);
    }
  }, [order, refreshToken, routePath, sort]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const currentPath = data?.current?.relativePath ?? routePath;
  const entries = data?.items ?? data?.entries ?? [];
  const breadcrumbs = useMemo(() => {
    if (data?.breadcrumbs?.length) return data.breadcrumbs;
    const parts = currentPath.replace(/\\/g, "/").split("/").filter(Boolean);
    return [{ name: "/", relativePath: "" }, ...parts.map((name, index) => ({ name, relativePath: parts.slice(0, index + 1).join("/") }))];
  }, [currentPath, data?.breadcrumbs]);

  function changeSort(next: SortKey) {
    if (next === sort) setOrder((value) => value === "asc" ? "desc" : "asc");
    else {
      setSort(next);
      setOrder(next === "name" || next === "type" ? "asc" : "desc");
    }
  }

  function sortLabel(key: SortKey, label: string) {
    const active = sort === key;
    return `${label}${active ? order === "asc" ? " ↑" : " ↓" : ""}`;
  }

  const parent = data?.parent === undefined ? parentOf(currentPath) : data.parent;
  const atRoot = !currentPath || parent === null;

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><h1>Disk Usage</h1><p>Inspect local disk consumption by directory.</p></div>
      <div className={styles.actions}>
        {atRoot ? <span className={styles.disabled}>← Parent</span> : <Link to={diskHref(parent ?? "")}>← Parent</Link>}
        <button type="button" onClick={() => { refreshRequested.current = true; setRefreshToken((value) => value + 1); }}>Refresh</button>
      </div>
    </header>

    <nav className={styles.breadcrumbs} aria-label="Disk path">
      {breadcrumbs.map((crumb, index) => <span key={`${crumb.relativePath}:${index}`}>
        {index > 0 && <span aria-hidden="true">/</span>}
        <Link to={diskHref(crumb.relativePath)} aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}>{crumb.name}</Link>
      </span>)}
    </nav>
    <div className={styles.path}>{currentPath || "/"}</div>

    {loading && <div className={styles.state} role="status">Loading disk usage…</div>}
    {error && <div className={styles.error} role="alert">{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    {!error && data && <>
      <section className={styles.metrics} aria-label="Disk scan summary">
        <article><span>Total size</span><strong>{formatBytes(data.totalSize)}</strong><small>{data.partial ? "partial result" : "scanned contents"}</small></article>
        <article><span>Files</span><strong>{data.fileCount ?? 0}</strong><small>files in scan</small></article>
        <article><span>Directories</span><strong>{data.directoryCount ?? 0}</strong><small>directories in scan</small></article>
        <article><span>Scan</span><strong>{formatDate(data.scannedAt)}</strong><small>{Number.isFinite(data.durationMs) ? `${data.durationMs} ms` : "—"} · {data.partial ? "partial" : "complete"}</small></article>
      </section>
      {data.partial && <div className={styles.partial} role="status">This scan is partial; totals may be incomplete.</div>}
      <div className={styles.tableWrap}>
        {entries.length ? <table><thead><tr>
          {(["name", "type", "size"] as SortKey[]).map((key) => <th key={key}><button type="button" onClick={() => changeSort(key)} aria-label={`Sort by ${key}${sort === key ? `, ${order === "asc" ? "ascending" : "descending"}` : ""}`}>{sortLabel(key, key[0].toUpperCase() + key.slice(1))}</button></th>)}
          <th>Share</th><th><button type="button" onClick={() => changeSort("modified")}>{sortLabel("modified", "Modified")}</button></th>
        </tr></thead><tbody>{entries.map((item) => {
          const percent = Math.max(0, Math.min(100, Number.isFinite(item.percent) ? Number(item.percent) : data.totalSize ? item.size / data.totalSize * 100 : 0));
          return <tr key={item.relativePath || item.name}>
            <td>{item.type === "directory" && item.canDrillDown ? <Link to={diskHref(item.relativePath)}>▸ {item.name}</Link> : <span>{item.type === "symlink" ? "↗ " : "· "}{item.name}</span>}</td>
            <td><span className={styles.badge}>{item.type}</span></td><td className={styles.numeric}>{formatBytes(item.size)}</td>
            <td><div className={styles.share}><progress aria-label={`${item.name} disk share`} value={percent} max={100} /><small>{percent.toFixed(percent >= 10 ? 0 : 1)}%</small></div></td>
            <td>{formatDate(item.modifiedAt)}</td>
          </tr>;
        })}</tbody></table> : <div className={styles.state}>This directory has no entries.</div>}
      </div>
      {!!data.diagnostics?.length && <details className={styles.diagnostics}><summary>Diagnostics ({data.diagnostics.length})</summary>{data.diagnostics.map((item, index) => <pre key={index}>{typeof item === "string" ? item : JSON.stringify(item, null, 2)}</pre>)}</details>}
    </>}
  </main>;
}
