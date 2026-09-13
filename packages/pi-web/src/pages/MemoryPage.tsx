import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ArtifactDetail, Logs, Phase2, RolloutDetail } from "./memory/Details";
import { IndexedSessions, Jobs, Rollouts } from "./memory/Lists";
import { MemoryOverview } from "./memory/Overview";
import { MemoryData, memoryRoutes, value } from "./memory/model";
import styles from "./memory/memory.module.less";

type Page = "overview" | "jobs" | "sessions" | "rollouts" | "phase2" | "logs" | "artifact";

function routeParts(path: string) {
  const [candidate = "overview", ...rest] = path.split("/").filter(Boolean);
  const valid = new Set(["overview", "jobs", "sessions", "rollouts", "phase2", "logs", "artifact"]);
  return { page: (valid.has(candidate) ? candidate : "overview") as Page, id: rest.join("/") };
}

const copy: Record<Page, [string, string]> = {
  overview: ["Memory Overview", "Memory database health, processing pipeline, workers, and published artifacts."],
  jobs: ["Jobs", "Safe job fields only; payloads and ownership tokens are never displayed."],
  sessions: ["Indexed Sessions", "Sessions known to the memory index and their scan state."],
  rollouts: ["Rollout Memory", "Metadata only. Sensitive content loads only after explicit confirmation."],
  phase2: ["Phase 2", "Global consolidation, selection watermark, materialization consistency, and recall usage."],
  logs: ["Logs", "Bounded, read-only worker diagnostics."],
  artifact: ["Artifact detail", "Read-only memory artifact details."],
};

export default function MemoryPage() {
  const path = useParams()["*"] ?? "overview";
  const { page, id } = routeParts(path);
  const [data, setData] = useState<MemoryData>();
  const [secondary, setSecondary] = useState<MemoryData>();
  const [tertiary, setTertiary] = useState<MemoryData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const current = () => generation.current === requestGeneration;
    setLoading(true); setError(""); setData(undefined); setSecondary(undefined); setTertiary(undefined);
    try {
      if (page === "overview") {
        const [overview, workers, artifacts] = await Promise.all([api<MemoryData>("/api/memory/observatory/overview"), api<MemoryData>("/api/memory/observatory/workers"), api<MemoryData>("/api/memory/observatory/artifacts")]);
        if (current()) { setData(overview); setSecondary(workers); setTertiary(artifacts); }
      } else if (page === "artifact" && id) {
        const detail = await api<MemoryData>(`/api/memory/observatory/artifacts/${encodeURIComponent(id)}`);
        if (current()) setData(detail);
      } else if (page === "rollouts" && id) {
        const result = await api<MemoryData>(`/api/memory/observatory/phase1/${encodeURIComponent(id)}`);
        if (current()) setData(result);
      } else {
        const endpoint = page === "rollouts" ? "phase1" : page;
        const result = await api<MemoryData>(`/api/memory/observatory/${endpoint}`);
        if (current()) setData(result);
      }
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (current()) setLoading(false);
    }
  }, [id, page]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  const title = page === "artifact" && data ? String(value(data.artifact ?? data.item ?? data, ["name", "title"], copy[page][0])) : id && page === "rollouts" ? "Rollout detail" : copy[page][0];

  return <main className={styles.page}>
    <header className={styles.header}><div><h1>{title}</h1><p>{copy[page][1]}</p></div>{(page === "artifact" || (page === "rollouts" && id)) && <Link to={page === "artifact" ? "/memory/overview" : "/memory/rollouts"}>← Back</Link>}</header>
    <nav className={styles.nav} aria-label="Memory Observatory">{memoryRoutes.map(([route, label]) => <Link key={route} to={`/memory/${route}`} aria-current={page === route ? "page" : undefined}>{label}</Link>)}</nav>
    {loading && <div className={styles.empty} role="status">Loading memory data…</div>}
    {error && <div className={styles.error} role="alert">{error}<button type="button" onClick={() => void load()}>Retry</button></div>}
    {!loading && !error && data && <>
      {page === "overview" && <MemoryOverview overview={data} workers={secondary ?? {}} artifactsData={tertiary ?? {}} />}
      {page === "jobs" && <Jobs data={data} />}
      {page === "sessions" && <IndexedSessions data={data} />}
      {page === "rollouts" && (id ? <RolloutDetail id={id} data={data} /> : <Rollouts data={data} />)}
      {page === "phase2" && <Phase2 data={data} />}
      {page === "logs" && <Logs data={data} />}
      {page === "artifact" && <ArtifactDetail id={id} data={data} />}
    </>}
  </main>;
}
