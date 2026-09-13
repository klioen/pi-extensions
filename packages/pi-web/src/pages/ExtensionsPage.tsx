import { useCallback, useEffect, useState } from "react";
import type { ApiRequest } from "./shared/request";
import { requestJson } from "./shared/request";
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, formatValue } from "./shared/view";
import styles from "./ExtensionsPage.module.less";

type Item = string | { displayName?: string; name?: string; relativePath?: string; source?: string; id?: string; package?: string; description?: string; version?: string; scope?: string; type?: string; path?: string; entry?: string; sourcePath?: string };
type ExtensionResponse = { entries?: Item[]; extensions?: Item[]; diagnostics?: unknown[]; settings?: { packages?: Item[]; extensionPaths?: Item[]; diagnostics?: unknown[] } };

function InventoryItem({ item }: { item: Item }) {
  if (typeof item === "string") return <div className={styles.item}><strong>{item}</strong></div>;
  const title = item.displayName ?? item.name ?? item.relativePath ?? item.source ?? item.id ?? item.package ?? "Extension";
  const source = item.source ?? item.relativePath ?? item.path ?? item.entry ?? item.sourcePath;
  return <div className={styles.item}><div><span><strong>{title}</strong>{(item.description ?? item.version) && <p>{item.description ?? item.version}</p>}</span><Badge tone="info">{item.scope ?? item.type ?? "configured"}</Badge></div>{source && <code>{source}</code>}</div>;
}

export default function ExtensionsPage({ request = requestJson }: { request?: ApiRequest }) {
  const [data, setData] = useState<ExtensionResponse>(); const [error, setError] = useState<unknown>();
  const load = useCallback(() => { setError(undefined); request<ExtensionResponse>("/api/extensions").then(setData, setError); }, [request]);
  useEffect(load, [load]);
  if (error) return <ErrorState error={error} retry={load} />;
  if (!data) return <LoadingState />;
  const extensions = data.entries ?? data.extensions ?? []; const packages = data.settings?.packages ?? []; const paths = data.settings?.extensionPaths ?? []; const diagnostics = [...(data.diagnostics ?? []), ...(data.settings?.diagnostics ?? [])];
  return <main className={styles.page}><PageHeader title="Extensions & packages" description="Static inventory only. Pi Web does not load extension code or mutate packages." />
    <section className={styles.grid}><article><header><h2>Extension entries</h2><Badge tone="info">{extensions.length} found</Badge></header>{extensions.length ? <div className={styles.stack}>{extensions.map((item, index) => <InventoryItem item={item} key={typeof item === "string" ? item : item.id ?? item.path ?? index} />)}</div> : <EmptyState>No extension entries found.</EmptyState>}</article>
      <article><header><h2>Packages</h2><Badge tone="info">{packages.length} configured</Badge></header>{packages.length ? <div className={styles.stack}>{packages.map((item, index) => <InventoryItem item={item} key={typeof item === "string" ? item : item.id ?? item.source ?? index} />)}</div> : <EmptyState>No packages returned.</EmptyState>}</article>
      <article><header><h2>Configured paths</h2><Badge tone="neutral">{paths.length} paths</Badge></header>{paths.length ? <div className={styles.stack}>{paths.map((item, index) => <InventoryItem item={item} key={index} />)}</div> : <EmptyState>No extension paths configured.</EmptyState>}</article>
      <article><header><h2>Diagnostics</h2><Badge tone={diagnostics.length ? "warn" : "good"}>{diagnostics.length || "healthy"}</Badge></header>{diagnostics.length ? <pre>{formatValue(diagnostics)}</pre> : <p className={styles.healthy}>No diagnostics reported.</p>}</article>
    </section></main>;
}
