import { Link } from "react-router-dom";
import { Facts, formatBytes, formatDate, list, MemoryData, Notice, Status, Table, value } from "./model";
import styles from "./memory.module.less";

const expectedArtifacts = ["memory_summary.md", "MEMORY.md", "raw_memories.md", "rollout_summaries", "skills"];

function artifactId(item: any) { return String(value(item, ["id", "artifactId", "artifact_id"], "")); }
function artifactName(item: any) { return String(value(item, ["name", "title", "path", "id"], "Unnamed artifact")); }
function isDirectory(item: any) { return Array.isArray(item?.items) || /directory|folder|collection/i.test(String(value(item, ["kind", "type"], ""))); }

export function MemoryOverview({ overview, workers, artifactsData }: { overview: MemoryData; workers: MemoryData; artifactsData: MemoryData }) {
  const artifacts = list(artifactsData, ["items", "artifacts"]);
  const byName = new Map(artifacts.map((item) => [artifactName(item).replace(/\/$/, ""), item]));
  const resources = expectedArtifacts.map((name) => byName.get(name) ?? { name, kind: ["rollout_summaries", "skills"].includes(name) ? "directory" : "file", status: "missing" });
  const stages = list(overview, ["pipeline", "stages", "items"]);
  const pipeline = stages.length ? stages : ["Session scan", "Phase 1 extraction", "Phase 2 consolidation", "Artifact publication"].map((name) => ({ name, status: "unknown" }));
  const workerItems = list(workers, ["items", "workers", "leases"]);
  return <>
    <Notice data={overview} always />
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Pipeline</h2><Status>{value(overview, ["pipelineStatus", "status"], "unknown")}</Status></div>
      <div className={styles.pipeline}>{pipeline.map((stage, index) => <article key={index}><b>{index + 1}</b><div><strong>{value(stage, ["name", "stage", "label"], `Stage ${index + 1}`)}</strong><small>{formatDate(value(stage, ["updatedAt", "updated_at", "timestamp", "time"], null))}</small></div><Status>{value(stage, ["status", "state"], "unknown")}</Status></article>)}</div>
    </section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Worker leases</h2><span>{workerItems.length} workers</span></div>
      <Table headings={["Worker", "Status", "Heartbeat", "Lease expires"]} rows={workerItems.map((item) => [<strong>{value(item, ["ownerId", "workerId", "leaseKey", "id"], "—")}</strong>, <Status>{value(item, ["status", "state"], "unknown")}</Status>, formatDate(value(item, ["heartbeatAt", "updatedAt"], null)), formatDate(value(item, ["leaseUntil", "expiresAt"], null))])} />
    </section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>Memory files and directories</h2><span>{resources.length} resources</span></div>
      <div className={styles.artifactGrid}>{resources.map((item) => { const id = artifactId(item); const directory = isDirectory(item); return <article key={artifactName(item)}>
        <div className={styles.sectionTitle}><h3>{id ? <Link to={`/memory/artifact/${encodeURIComponent(id)}`}>{artifactName(item)}</Link> : artifactName(item)}</h3><Status>{value(item, ["status", "consistency"], id ? "available" : "missing")}</Status></div>
        <Facts values={{ Type: directory ? "Directory" : "File", Updated: formatDate(value(item, ["modifiedAt", "updatedAt", "mtime"], null)), [directory ? "Contents" : "Size"]: directory ? `${value(item, ["itemCount", "entryCount", "count"], "—")} entries` : formatBytes(value(item, ["bytes", "size"], -1)) }} />
        {id && <Link to={`/memory/artifact/${encodeURIComponent(id)}`}>View details →</Link>}
      </article>; })}</div>
    </section>
  </>;
}
