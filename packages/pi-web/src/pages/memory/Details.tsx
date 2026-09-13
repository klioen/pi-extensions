import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { Empty, Facts, formatBytes, formatDate, list, MemoryData, Notice, Status, value } from "./model";
import styles from "./memory.module.less";

export function RolloutDetail({ id, data }: { id: string; data: MemoryData }) {
  const [pendingField, setPendingField] = useState<"rolloutSummary" | "rawMemory" | null>(null);
  const [loaded, setLoaded] = useState<{ label: string; content: string; truncated?: boolean }>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPendingField(null); setLoaded(undefined); setError("");
    return () => { generation.current += 1; };
  }, [id]);
  async function confirmLoad() {
    if (!pendingField) return;
    const field = pendingField;
    const requestGeneration = ++generation.current;
    setPendingField(null);
    setError("");
    try {
      const result = await api<MemoryData>(`/api/memory/observatory/phase1/${encodeURIComponent(id)}/content?field=${field}`);
      if (generation.current === requestGeneration) setLoaded({ label: field === "rawMemory" ? "raw memory" : "rollout summary", content: String(value(result, ["content", "text", "value", field], "")), truncated: result.truncated });
    } catch (caught) {
      if (generation.current === requestGeneration) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return <><Notice data={data} /><div className={styles.detailGrid}><article className={styles.card}><div className={styles.sectionTitle}><h2>Metadata</h2><Status>{value(data, ["status", "state"], "available")}</Status></div><Facts values={{ "Session ID": value(data, ["sessionId"], id), Generated: formatDate(value(data, ["generatedAt"], null)), "Raw bytes": value(data, ["rawMemoryBytes"], 0), "Summary bytes": value(data, ["rolloutSummaryBytes"], 0), "Selected for Phase 2": String(value(data, ["selectedForPhase2"], false)), Materialized: value(data?.materialized, ["name"], "—") }} /></article>
    <article className={styles.card}><div className={styles.sectionTitle}><h2>Bounded sensitive content</h2><Status>confirmation required</Status></div><p>Each field is fetched separately only after confirmation. It may contain private conversation or tool output.</p><div className={styles.actions}><button type="button" onClick={() => setPendingField("rolloutSummary")}>Load rollout summary</button><button type="button" className={styles.danger} onClick={() => setPendingField("rawMemory")}>Load raw memory</button></div>{error && <p role="alert">{error}</p>}{loaded && <div><h3>{loaded.label}</h3><Status>{loaded.truncated ? "truncated" : "loaded"}</Status><pre>{loaded.content}</pre></div>}</article></div>
    {pendingField && <div className={styles.dialogBackdrop}><div role="dialog" aria-modal="true" aria-labelledby="sensitive-title" className={styles.dialog}><h2 id="sensitive-title">Load {pendingField === "rawMemory" ? "raw memory" : "rollout summary"}?</h2><p>This makes a separate request for bounded sensitive content. It may contain private session data.</p><div className={styles.actions}><button type="button" onClick={() => setPendingField(null)}>Cancel</button><button type="button" onClick={() => void confirmLoad()}>Confirm and load</button></div></div></div>}
  </>;
}

export function Phase2({ data }: { data: MemoryData }) {
  const selected = list(data, ["selectedOutputs", "selected_outputs", "items"]);
  const artifacts = list(data, ["artifacts", "publishedArtifacts"]);
  return <><Notice data={data} /><div className={styles.metrics}><article><span>Global job</span><strong>{value(data, ["jobStatus", "status"], "unknown")}</strong></article><article><span>Watermark</span><strong>{value(data, ["watermark", "selectionWatermark"])}</strong></article><article><span>Selected</span><strong>{selected.length}</strong></article><article><span>Recall usage</span><strong>{data.recallUsage?.total ?? value(data, ["recalls"], 0)}</strong></article></div><div className={styles.detailGrid}><article className={styles.card}><h2>Materialization</h2><Facts values={{ "Selected outputs": selected.length, "Published artifacts": artifacts.length, "Last run": formatDate(value(data, ["lastSuccessAt", "updatedAt"], null)), Consistency: value(data, ["consistency", "materializationStatus"], "unknown") }} /></article><article className={styles.card}><h2>Selected outputs</h2>{selected.length ? selected.map((item, index) => <code className={styles.block} key={index}>{value(item, ["sessionId", "id"], item)}</code>) : <Empty>No selected outputs returned.</Empty>}</article></div></>;
}

export function Logs({ data }: { data: MemoryData }) {
  const items = list(data, ["items", "logs", "entries"]);
  const text = typeof data.value === "string" ? data.value : "";
  return <><Notice data={data} /><article className={styles.card}><div className={styles.sectionTitle}><h2>Worker log</h2><Status>{data.truncated ? "truncated" : "bounded"}</Status></div>{text ? <pre>{text}</pre> : items.length ? <div className={styles.logs}>{items.map((item, index) => <div key={index}><time>{formatDate(value(item, ["timestamp", "time", "createdAt"], null))}</time><Status>{value(item, ["level", "status"], "info")}</Status><pre>{String(value(item, ["message", "text", "line"], JSON.stringify(item)))}</pre></div>)}</div> : <Empty>No log entries returned.</Empty>}</article></>;
}

export function ArtifactDetail({ id, data }: { id: string; data: MemoryData }) {
  const artifact = data.artifact ?? data.item ?? data;
  const entries = list(artifact, ["entries", "items", "children"]);
  const directory = Array.isArray(artifact.entries) || /directory|folder|collection/i.test(String(value(artifact, ["kind", "type"], "")));
  const name = String(value(artifact, ["name", "title", "path", "id"], "artifact file"));
  const [confirming, setConfirming] = useState(false);
  const [content, setContent] = useState<MemoryData>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setConfirming(false); setContent(undefined); setError("");
    return () => { generation.current += 1; };
  }, [id]);
  async function confirmLoad() {
    const requestGeneration = ++generation.current;
    setConfirming(false); setError("");
    try {
      const result = await api<MemoryData>(`/api/memory/observatory/artifacts/${encodeURIComponent(id)}/content`);
      if (generation.current === requestGeneration) setContent(result);
    } catch (caught) {
      if (generation.current === requestGeneration) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return <><div className={styles.detailGrid}><aside className={styles.card}><h2>Metadata</h2><Facts values={{ Type: directory ? "Directory" : value(artifact, ["kind", "type"], "File"), Status: value(artifact, ["status", "consistency"], "available"), Updated: formatDate(value(artifact, ["modifiedAt", "updatedAt"], null)), [directory ? "Entries" : "Size"]: directory ? entries.length : formatBytes(value(artifact, ["bytes", "size"], -1)) }} /></aside><article className={styles.card}><h2>{directory ? "Contents" : "File content"}</h2>{directory ? entries.length ? <ul>{entries.map((item, index) => { const object = typeof item === "string" ? { name: item, id: item } : item; const childId = String(value(object, ["id", "artifactId"], "")); return <li key={index}>{childId ? <Link to={`/memory/artifact/${encodeURIComponent(childId)}`}>{value(object, ["name", "title", "id"])}</Link> : value(object, ["name", "title"], "Unnamed")}</li>; })}</ul> : <Empty>This directory has no published items.</Empty> : <><p>File content is fetched separately only after explicit confirmation. Memory artifacts may contain private session data.</p><div className={styles.actions}><button type="button" className={styles.danger} onClick={() => setConfirming(true)}>Load file content</button></div>{error && <p role="alert">{error}</p>}{content && <><Status>{content.truncated ? "truncated" : "read only"}</Status><pre>{String(value(content, ["content", "text", "markdown", "value"], ""))}</pre></>}</>}</article></div>
    {confirming && <div className={styles.dialogBackdrop}><div role="dialog" aria-modal="true" aria-labelledby="artifact-content-title" className={styles.dialog}><h2 id="artifact-content-title">Load {name}?</h2><p>This makes a separate request for file content, which may contain private memory or session data.</p><div className={styles.actions}><button type="button" onClick={() => setConfirming(false)}>Cancel</button><button type="button" onClick={() => void confirmLoad()}>Confirm and load</button></div></div></div>}
  </>;
}
