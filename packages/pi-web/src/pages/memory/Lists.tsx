import { Link } from "react-router-dom";
import { formatDate, list, MemoryData, Notice, Status, Table, value } from "./model";
import styles from "./memory.module.less";

export function Jobs({ data }: { data: MemoryData }) {
  const items = list(data, ["items", "jobs"]);
  return <><Notice data={data} /><Table headings={["Job", "Status", "Retries left", "Created", "Updated", "Error"]} rows={items.map((item) => [<><strong>{value(item, ["kind", "type", "jobType", "id"])}</strong><small className={styles.block}>{value(item, ["jobKey", "id", "jobId"], "")}</small></>, <Status>{value(item, ["state", "status"], "unknown")}</Status>, value(item, ["retryRemaining", "attempts", "attemptCount"]), formatDate(value(item, ["createdAt", "created_at"], null)), formatDate(value(item, ["updatedAt", "finishedAt"], null)), value(item, ["lastError", "error", "last_error"])])} /></>;
}

export function IndexedSessions({ data }: { data: MemoryData }) {
  const items = list(data, ["items", "sessions"]);
  return <><Notice data={data} /><Table headings={["Session", "Scan", "Phase 1", "Modified"]} rows={items.map((item) => [<><strong>{value(item, ["title", "sessionId", "id"])}</strong><small className={styles.block}>{value(item, ["sessionId", "id"], "")}</small></>, <Status>{value(item, ["scanStatus", "status"], "unknown")}</Status>, <Status>{value(item, ["phase1Status", "phase1State"], "unknown")}</Status>, formatDate(value(item, ["updatedAt", "lastSeenAt", "modifiedAt"], null))])} /></>;
}

export function Rollouts({ data }: { data: MemoryData }) {
  const items = list(data, ["items", "phase1", "outputs"]);
  return <><Notice data={data} /><div className={styles.legend}>raw_memory: per-rollout extraction · rollout_summary: per-rollout summary · rollout_summaries/*.md: materialized files · raw_memories.md: collection input</div>
    <Table headings={["Session", "Status", "Raw bytes", "Summary bytes", "Generated"]} rows={items.map((item) => { const id = String(value(item, ["sessionId", "id"], "")); return [<><Link to={`/memory/rollouts/${encodeURIComponent(id)}`}>{value(item, ["title", "sessionId", "id"])}</Link><small className={styles.block}>{id}</small></>, <Status>{value(item, ["status", "state"], "available")}</Status>, value(item, ["rawMemoryBytes", "rawMemoryLength"]), value(item, ["rolloutSummaryBytes", "rolloutSummaryLength"]), formatDate(value(item, ["generatedAt", "updatedAt"], null))]; })} />
  </>;
}
