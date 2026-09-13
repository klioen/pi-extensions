import { useCallback, useEffect, useState } from "react";
import type { ApiRequest } from "./shared/request";
import { requestJson } from "./shared/request";
import { Badge, DefinitionList, EmptyState, ErrorState, LoadingState, PageHeader, formatDate } from "./shared/view";
import styles from "./OverviewPage.module.less";

type Session = { id?: string; sessionId?: string; name?: string; title?: string; firstMessage?: string; modified?: string | number; updatedAt?: string | number; current?: boolean };
type Overview = { cwd?: string; projectTrusted?: boolean; recentSessions?: Session[]; counts?: { sessions?: number; skills?: number; extensions?: number; packages?: number }; memory?: Record<string, unknown> };

export default function OverviewPage({ request = requestJson }: { request?: ApiRequest }) {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState<unknown>();
  const load = useCallback(() => { setError(undefined); request<Overview>("/api/overview").then(setData, setError); }, [request]);
  useEffect(load, [load]);
  if (error) return <ErrorState error={error} retry={load} />;
  if (!data) return <LoadingState />;
  const counts = data.counts ?? {};
  const metrics = [
    ["Sessions", counts.sessions ?? 0, "indexed conversations"],
    ["Skills", counts.skills ?? 0, "available capabilities"],
    ["Extensions", (counts.extensions ?? 0) + (counts.packages ?? 0), "extensions and packages"],
    ["Memory", Object.values(data.memory ?? {}).filter(Boolean).length, "documents and logs"],
  ] as const;
  return <main className={styles.page}>
    <PageHeader title="System overview" description="A readout of this Pi installation and its local assets." />
    <section className={styles.metrics} aria-label="Overview metrics">{metrics.map(([label, value, note]) => <article className={styles.card} key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</section>
    <section className={styles.columns}>
      <article className={styles.panel}><div className={styles.panelHeader}><h2>Recent sessions</h2><a href="#/sessions">View all →</a></div>
        {data.recentSessions?.length ? <div className={styles.list}>{data.recentSessions.slice(0, 6).map((session) => { const id = session.id ?? session.sessionId ?? ""; return <a href={`#/sessions/${encodeURIComponent(id)}`} key={id}><span><strong>{session.name ?? session.title ?? session.firstMessage ?? id}</strong><code>{id}</code></span><time>{formatDate(session.modified ?? session.updatedAt)}</time></a>; })}</div> : <EmptyState>No recent sessions were returned.</EmptyState>}
      </article>
      <article className={styles.panel}><div className={styles.panelHeader}><h2>Runtime</h2><Badge tone="good">loopback</Badge></div><DefinitionList values={{ Project: data.cwd ?? "—", "Project trusted": data.projectTrusted ? "yes" : "no", Transport: "same-origin loopback" }} /></article>
    </section>
  </main>;
}
