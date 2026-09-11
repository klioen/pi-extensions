"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_LOG_BYTES = 256 * 1024;
const TABLES = ["jobs", "phase1_outputs", "worker_leases", "sessions", "session_scan_state", "kv"];
const REQUIRED = Object.freeze({
	jobs: ["kind", "job_key", "status", "worker_id", "lease_until", "retry_until", "retry_remaining", "last_error", "created_at", "finished_at", "started_at", "input_watermark", "last_success_watermark"],
	phase1: ["session_id", "source_updated_at", "raw_memory", "rollout_summary", "generated_at", "rollout_slug", "usage_count", "last_usage", "selected_for_phase2", "selected_for_phase2_source_updated_at"],
	workers: ["lease_key", "owner_id", "lease_until", "heartbeat_at", "created_at"],
	sessions: ["session_id", "updated_at", "last_seen_at"],
	scan: ["scan_key", "requested_generation", "completed_generation", "requested_at"],
});

function clampInteger(value, fallback, minimum, maximum) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function pageOptions(options = {}) {
	return { limit: clampInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT), offset: clampInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER) };
}

function page(items, limit, offset) {
	const hasMore = items.length > limit;
	if (hasMore) items.pop();
	return { items, page: { limit, offset, returned: items.length, hasMore } };
}

function unavailable(name, options) {
	const { limit, offset } = pageOptions(options);
	return { items: [], page: { limit, offset, returned: 0, hasMore: false }, unavailable: `${name} table is unavailable` };
}

function redactSecrets(value) {
	let text = String(value ?? "");
	text = text.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
	text = text.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|ark-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_SECRET]");
	text = text.replace(/((?:authorization|cookie|set-cookie)\s*:\s*(?:bearer\s+)?)[^\s;"']+/gi, "$1[REDACTED_SECRET]");
	text = text.replace(/(https?:\/\/)[^\s/:@]+:[^\s@/]+@/gi, "$1[REDACTED_SECRET]@");
	text = text.replace(/((?:api[_-]?key|secret|password|access[_-]?key|github[_-]?token|ark[_-]?api[_-]?keys?|token)\s*[:=]\s*["']?)[^\s,&"'\n}]+/gi, "$1[REDACTED_SECRET]");
	return text;
}

function redactPaths(value) {
	return String(value ?? "").replace(/(^|[\s=("'])(\/(?:Users|home|var|tmp|private|opt|etc)\/[^\s,"')\]]+)/g, "$1[REDACTED_PATH]");
}

function sanitizeDiagnosticText(value) {
	return redactPaths(redactSecrets(value));
}

function safeError(value) {
	return value == null ? null : sanitizeDiagnosticText(value).slice(0, 2000);
}

function probeCapabilities(db) {
	const tables = {};
	const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
	const existing = new Set(rows.map((row) => row.name));
	for (const name of TABLES) {
		const columns = existing.has(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name) : [];
		tables[name] = { available: existing.has(name), columns };
	}
	const has = (table, columns) => tables[table].available && columns.every((column) => tables[table].columns.includes(column));
	const features = {
		jobs: has("jobs", REQUIRED.jobs), phase1: has("phase1_outputs", REQUIRED.phase1), workers: has("worker_leases", REQUIRED.workers),
		sessions: has("sessions", REQUIRED.sessions), scan: has("session_scan_state", REQUIRED.scan), kv: tables.kv.available && tables.kv.columns.includes("key") && tables.kv.columns.includes("value"),
	};
	// Capabilities are returned to callers, so omit forbidden sensitive column
	// names after using the complete schema internally for feature detection.
	for (const table of Object.values(tables)) table.columns = table.columns.filter((column) => column !== "payload" && column !== "ownership_token");
	return { tables, features };
}

function openMemoryObservatory(options = {}) {
	const dbPath = path.resolve(String(options.dbPath ?? ""));
	const memoryDir = path.resolve(String(options.memoryDir ?? path.dirname(dbPath)));
	if (!options.dbPath || !fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
		return { db: null, dbPath, memoryDir, availability: { available: false, reason: "memory database does not exist" }, capabilities: { tables: {}, features: {} }, close() {} };
	}
	let db;
	try {
		// readOnly uses SQLite's normal pager, so a WAL database is read as one
		// consistent SQLite snapshot without copying, checkpointing, or mutation.
		db = new DatabaseSync(dbPath, { readOnly: true });
		const capabilities = probeCapabilities(db);
		return { db, dbPath, memoryDir, availability: { available: true }, capabilities, close() { db.close(); } };
	} catch (error) {
		try { db?.close(); } catch {}
		return { db: null, dbPath, memoryDir, availability: { available: false, reason: safeError(error?.message ?? error) }, capabilities: { tables: {}, features: {} }, close() {} };
	}
}

function assertOpen(observatory) {
	return Boolean(observatory?.availability?.available && observatory.db);
}

function count(db, table) {
	return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function deriveWorkerState(row, now) {
	return Number(row.lease_until) > now ? "active" : "expired";
}

function deriveJobState(row, now) {
	if ((row.status === "leased" || row.status === "running") && Number(row.lease_until) <= now) return "lease-expired";
	if (row.status === "leased" || row.status === "running") return "running";
	if (row.status === "pending") return "queued";
	if (row.status === "failed") {
		if (Number(row.retry_remaining) <= 0) return "exhausted";
		return row.retry_until != null && Number(row.retry_until) > now ? "retry-wait" : "retry-ready";
	}
	return row.status || "unknown";
}

function mapJob(row, now) {
	return {
		kind: row.kind, jobKey: row.job_key, status: row.status, state: deriveJobState(row, now), workerId: row.worker_id ?? null,
		leaseUntil: row.lease_until ?? null, retryUntil: row.retry_until ?? null, retryRemaining: row.retry_remaining ?? null,
		lastError: safeError(row.last_error), createdAt: row.created_at ?? null, startedAt: row.started_at ?? null,
		finishedAt: row.finished_at ?? null, inputWatermark: row.input_watermark ?? null, lastSuccessWatermark: row.last_success_watermark ?? null,
	};
}

function recallUsage(observatory) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return { total: 0, usedOutputs: 0, lastUsedAt: null };
	const row = observatory.db.prepare(`SELECT COALESCE(SUM(COALESCE(usage_count,0)),0) AS total, SUM(CASE WHEN COALESCE(usage_count,0)>0 THEN 1 ELSE 0 END) AS used_outputs, MAX(last_usage) AS last_used_at FROM phase1_outputs`).get();
	return { total: Number(row.total), usedOutputs: Number(row.used_outputs), lastUsedAt: row.last_used_at ?? null };
}

function latestScanState(observatory) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.scan) return { state: "unavailable", requestedGeneration: null, completedGeneration: null, requestedAt: null };
	const row = observatory.db.prepare(`SELECT scan_key,requested_generation,completed_generation,requested_at FROM session_scan_state ORDER BY requested_at DESC,scan_key LIMIT 1`).get();
	if (!row) return { state: "idle", requestedGeneration: 0, completedGeneration: 0, requestedAt: null };
	return { scanKey: row.scan_key, state: Number(row.requested_generation) > Number(row.completed_generation) ? "pending" : "completed", requestedGeneration: row.requested_generation, completedGeneration: row.completed_generation, requestedAt: row.requested_at };
}

function queryOverview(observatory, options = {}) {
	if (!assertOpen(observatory)) return { availability: observatory?.availability ?? { available: false }, capabilities: observatory?.capabilities ?? { tables: {}, features: {} }, counts: { jobs: 0, phase1: 0, sessions: 0, workers: 0, artifacts: 0 }, pipeline: [] };
	const features = observatory.capabilities.features; const now = options.now ?? Date.now();
	const artifacts = artifactSummary(observatory); const scanState = latestScanState(observatory);
	const counts = {
		jobs: features.jobs ? count(observatory.db, "jobs") : 0,
		phase1: features.phase1 ? count(observatory.db, "phase1_outputs") : 0,
		sessions: features.sessions ? count(observatory.db, "sessions") : 0,
		workers: features.workers ? count(observatory.db, "worker_leases") : 0,
		artifacts: artifacts.total,
	};
	const statuses = features.jobs ? observatory.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status").all().map((row) => ({ status: row.status, count: Number(row.count) })) : [];
	const activeWorkers = features.workers ? Number(observatory.db.prepare("SELECT COUNT(*) AS count FROM worker_leases WHERE lease_until > ?").get(now).count) : 0;
	const lastPhase1At = features.phase1 ? observatory.db.prepare("SELECT MAX(generated_at) AS value FROM phase1_outputs").get().value ?? null : null;
	const phase2Row = features.jobs ? observatory.db.prepare(`SELECT status,finished_at,lease_until,retry_until,retry_remaining FROM jobs WHERE kind='memory_consolidate_global' ORDER BY created_at DESC LIMIT 1`).get() : null;
	const lastPhase2At = kvValue(observatory, "phase2_last_success_at") ?? phase2Row?.finished_at ?? null;
	const pipeline = [
		{ name: "Session scan", status: scanState.state, updatedAt: scanState.requestedAt },
		{ name: "Phase 1 extraction", status: counts.phase1 > 0 ? "available" : features.phase1 ? "empty" : "unavailable", updatedAt: lastPhase1At },
		{ name: "Phase 2 consolidation", status: phase2Row ? deriveJobState(phase2Row, now) : features.jobs ? "idle" : "unavailable", updatedAt: lastPhase2At },
		{ name: "Artifact publication", status: artifacts.consistency, updatedAt: lastPhase2At },
	];
	const pipelineStatus = pipeline.some((stage) => ["mismatch", "lease-expired", "exhausted"].includes(stage.status)) ? "degraded" : pipeline.some((stage) => stage.status === "unavailable") ? "unavailable" : "available";
	const usage = recallUsage(observatory);
	return { availability: observatory.availability, capabilities: observatory.capabilities, counts, statuses, activeWorkers, pipelineStatus, pipeline, scanState, lastScanAt: scanState.requestedAt, lastPhase1At, lastPhase2At, recallUsage: usage.total, recallUsageSummary: usage, artifacts };
}

function queryWorkers(observatory, options = {}) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.workers) return unavailable("worker_leases", options);
	const { limit, offset } = pageOptions(options); const now = options.now ?? Date.now();
	const rows = observatory.db.prepare(`SELECT lease_key,owner_id,lease_until,heartbeat_at,created_at FROM worker_leases ORDER BY lease_until DESC,lease_key LIMIT ? OFFSET ?`).all(limit + 1, offset);
	return page(rows.map((row) => ({ leaseKey: row.lease_key, ownerId: row.owner_id, leaseUntil: row.lease_until, heartbeatAt: row.heartbeat_at, createdAt: row.created_at, state: deriveWorkerState(row, now) })), limit, offset);
}

function queryJobs(observatory, options = {}) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.jobs) return unavailable("jobs", options);
	const { limit, offset } = pageOptions(options); const now = options.now ?? Date.now();
	const clauses = [], parameters = [];
	if (options.kind) { clauses.push("kind=?"); parameters.push(String(options.kind)); }
	if (options.status) { clauses.push("status=?"); parameters.push(String(options.status)); }
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = observatory.db.prepare(`SELECT kind,job_key,status,worker_id,lease_until,retry_until,retry_remaining,last_error,created_at,finished_at,started_at,input_watermark,last_success_watermark FROM jobs ${where} ORDER BY created_at DESC,kind,job_key LIMIT ? OFFSET ?`).all(...parameters, limit + 1, offset);
	return page(rows.map((row) => mapJob(row, now)), limit, offset);
}

function querySessions(observatory, options = {}) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.sessions) return unavailable("sessions", options);
	const { limit, offset } = pageOptions(options); const q = String(options.q ?? "").trim(); const now = options.now ?? Date.now();
	const canJoinJobs = observatory.capabilities.features.jobs; const canJoinPhase1 = observatory.capabilities.features.phase1;
	const jobColumns = canJoinJobs ? ",j.status AS job_status,j.lease_until,j.retry_until,j.retry_remaining" : ",NULL AS job_status,NULL AS lease_until,NULL AS retry_until,NULL AS retry_remaining";
	const phase1Columns = canJoinPhase1 ? ",so.session_id AS output_session_id,so.source_updated_at" : ",NULL AS output_session_id,NULL AS source_updated_at";
	const joins = `${canJoinJobs ? " LEFT JOIN jobs j ON j.kind='phase1' AND j.job_key=s.session_id" : ""}${canJoinPhase1 ? " LEFT JOIN phase1_outputs so ON so.session_id=s.session_id" : ""}`;
	const where = q ? "WHERE s.session_id LIKE ? ESCAPE '\\'" : ""; const parameters = q ? [`%${q.replace(/[\\%_]/g, "\\$&")}%`] : [];
	const rows = observatory.db.prepare(`SELECT s.session_id,s.updated_at,s.last_seen_at${jobColumns}${phase1Columns} FROM sessions s${joins} ${where} ORDER BY s.updated_at DESC,s.session_id DESC LIMIT ? OFFSET ?`).all(...parameters, limit + 1, offset);
	return page(rows.map((row) => {
		const scanStatus = row.job_status ? deriveJobState({ status: row.job_status, lease_until: row.lease_until, retry_until: row.retry_until, retry_remaining: row.retry_remaining }, now) : "not-queued";
		const phase1State = !row.output_session_id ? "missing" : Number(row.source_updated_at) >= Number(row.updated_at) ? "up-to-date" : "stale";
		return { sessionId: row.session_id, updatedAt: row.updated_at, lastSeenAt: row.last_seen_at, phase1State, scanStatus, phase1Status: phase1State };
	}), limit, offset);
}

function phase1Metadata(row) {
	return {
		sessionId: row.session_id, sourceUpdatedAt: row.source_updated_at, generatedAt: row.generated_at ?? null, rolloutSlug: row.rollout_slug ?? null,
		rawMemoryBytes: Number(row.raw_memory_bytes ?? Buffer.byteLength(row.raw_memory ?? "")), rolloutSummaryBytes: Number(row.rollout_summary_bytes ?? Buffer.byteLength(row.rollout_summary ?? "")),
		usageCount: row.usage_count ?? 0, lastUsage: row.last_usage ?? null, selectedForPhase2: Boolean(row.selected_for_phase2),
		selectedSourceUpdatedAt: row.selected_for_phase2_source_updated_at ?? null,
	};
}

function booleanFilter(value) {
	if (value === true || value === "true" || value === "1" || value === 1) return true;
	if (value === false || value === "false" || value === "0" || value === 0) return false;
	return undefined;
}

function queryPhase1(observatory, options = {}) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return unavailable("phase1_outputs", options);
	const { limit, offset } = pageOptions(options); const clauses = [], parameters = [];
	const selected = booleanFilter(options.selected); const used = booleanFilter(options.used); const q = String(options.q ?? "").trim();
	if (selected !== undefined) clauses.push(`COALESCE(selected_for_phase2,0)=${selected ? 1 : 0}`);
	if (used !== undefined) clauses.push(used ? "COALESCE(usage_count,0)>0" : "COALESCE(usage_count,0)=0");
	if (q) { clauses.push("(session_id LIKE ? ESCAPE '\\' OR COALESCE(rollout_slug,'') LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`; parameters.push(like, like); }
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = observatory.db.prepare(`SELECT session_id,source_updated_at,length(CAST(raw_memory AS BLOB)) AS raw_memory_bytes,length(CAST(rollout_summary AS BLOB)) AS rollout_summary_bytes,generated_at,rollout_slug,usage_count,last_usage,selected_for_phase2,selected_for_phase2_source_updated_at FROM phase1_outputs ${where} ORDER BY source_updated_at DESC,session_id DESC LIMIT ? OFFSET ?`).all(...parameters, limit + 1, offset);
	return page(rows.map(phase1Metadata), limit, offset);
}

function rolloutStem(row) {
	const timestamp = new Date(Number(row.source_updated_at) || 0).toISOString().replace(/[:.]/g, "-").slice(0, 23);
	const slug = String(row.rollout_slug || "rollout").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${timestamp}-${slug}-${String(row.session_id).slice(0, 8)}`;
}

function readFileHeadBounded(file, maxBytes = DEFAULT_CONTENT_BYTES) {
	const size = fs.statSync(file).size; const length = Math.min(size, Math.max(0, maxBytes)); const buffer = Buffer.alloc(length); const fd = fs.openSync(file, "r");
	try { if (length) fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
	return { text: buffer.toString("utf8").replace(/\uFFFD$/, ""), bytes: length, totalBytes: size, truncated: size > length };
}

function expectedRolloutFile(observatory, row) {
	const name = `${rolloutStem(row)}.md`;
	const file = path.join(observatory.memoryDir, "rollout_summaries", name);
	if (!isContained(observatory.memoryDir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { name, exists: false, consistent: false, consistency: "missing" };
	const document = readFileHeadBounded(file);
	const headerMatches = document.text.includes(`session_id: ${row.session_id}\n`) && document.text.includes(`updated_at: ${new Date(Number(row.source_updated_at)).toISOString()}\n`);
	const summaryMatches = row.rollout_summary === undefined || document.text.includes(String(row.rollout_summary ?? ""));
	const consistent = !document.truncated && headerMatches && summaryMatches;
	return { name, exists: true, consistent, consistency: consistent ? "consistent" : document.truncated ? "unknown" : "mismatch" };
}

function queryPhase1Detail(observatory, sessionId) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return null;
	const row = observatory.db.prepare(`SELECT session_id,source_updated_at,length(CAST(raw_memory AS BLOB)) AS raw_memory_bytes,length(CAST(rollout_summary AS BLOB)) AS rollout_summary_bytes,generated_at,rollout_slug,usage_count,last_usage,selected_for_phase2,selected_for_phase2_source_updated_at FROM phase1_outputs WHERE session_id=?`).get(String(sessionId));
	if (!row) return null;
	return { ...phase1Metadata(row), materialized: expectedRolloutFile(observatory, row) };
}

function boundedString(value, maxBytes) {
	const source = Buffer.from(String(value ?? ""), "utf8"); const length = Math.min(source.length, clampInteger(maxBytes, DEFAULT_CONTENT_BYTES, 0, 16 * 1024 * 1024));
	return { content: source.subarray(0, length).toString("utf8").replace(/\uFFFD$/, ""), bytes: length, totalBytes: source.length, truncated: source.length > length };
}

function queryPhase1Content(observatory, sessionId, field, options = {}) {
	const columns = { rolloutSummary: "rollout_summary", rawMemory: "raw_memory" };
	if (!Object.hasOwn(columns, field)) throw Object.assign(new Error("Invalid phase1 content field"), { code: "INVALID_FIELD" });
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return null;
	const maxBytes = clampInteger(options.maxBytes, DEFAULT_CONTENT_BYTES, 1, 16 * 1024 * 1024);
	// SQLite substr limits materialization before the TEXT crosses into JS. The
	// extra suffix reduces false negatives when a secret ends at the byte cap.
	const row = observatory.db.prepare(`SELECT substr(CAST(${columns[field]} AS BLOB),1,?) AS content,length(CAST(${columns[field]} AS BLOB)) AS total_bytes FROM phase1_outputs WHERE session_id=?`).get(maxBytes + 512, String(sessionId));
	if (!row) return null;
	const redacted = redactSecrets(Buffer.from(row.content ?? []).toString("utf8"));
	const bounded = boundedString(redacted, maxBytes);
	return { field, sensitive: true, content: bounded.content, bytes: bounded.bytes, totalBytes: Number(row.total_bytes), truncated: Number(row.total_bytes) > maxBytes };
}

function kvValue(observatory, key) {
	if (!observatory.capabilities.features.kv) return null;
	const row = observatory.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
	if (!row) return null;
	try { return JSON.parse(row.value); } catch { return row.value; }
}

function queryPhase2(observatory, options = {}) {
	if (!assertOpen(observatory)) return { available: false, job: null, watermark: null, lastSuccessAt: null, selectedOutputs: [], consistency: "unavailable", recallUsage: { total: 0, usedOutputs: 0, lastUsedAt: null }, artifactSummary: { total: 0, consistent: 0, mismatched: 0, missing: 0, orphaned: 0, unknown: 0 }, artifacts: [] };
	const jobRow = observatory.capabilities.features.jobs ? observatory.db.prepare(`SELECT kind,job_key,status,worker_id,lease_until,retry_until,retry_remaining,last_error,created_at,finished_at,started_at,input_watermark,last_success_watermark FROM jobs WHERE kind='memory_consolidate_global' ORDER BY created_at DESC LIMIT 1`).get() : null;
	const selected = observatory.capabilities.features.phase1 ? observatory.db.prepare(`SELECT session_id,source_updated_at,length(CAST(raw_memory AS BLOB)) AS raw_memory_bytes,length(CAST(rollout_summary AS BLOB)) AS rollout_summary_bytes,generated_at,rollout_slug,usage_count,last_usage,selected_for_phase2,selected_for_phase2_source_updated_at FROM phase1_outputs WHERE selected_for_phase2=1 ORDER BY source_updated_at DESC,session_id DESC LIMIT 100`).all() : [];
	const artifacts = artifactRows(observatory).map(({ file, directory, ...item }) => item); const summary = summarizeArtifacts(artifacts);
	return { available: Boolean(jobRow || observatory.capabilities.features.phase1), job: jobRow ? mapJob(jobRow, options.now ?? Date.now()) : null, jobStatus: jobRow ? deriveJobState(jobRow, options.now ?? Date.now()) : "idle", watermark: kvValue(observatory, "phase2_last_watermark") ?? jobRow?.last_success_watermark ?? null, lastSuccessAt: kvValue(observatory, "phase2_last_success_at"), selectedOutputs: selected.map((row) => ({ ...phase1Metadata(row), materialized: expectedRolloutFile(observatory, row) })), consistency: summary.consistency, recallUsage: recallUsage(observatory), artifactSummary: summary, artifacts };
}

function isContained(root, candidate) {
	try {
		const canonicalRoot = fs.realpathSync.native(path.resolve(root));
		const resolvedCandidate = path.resolve(candidate);
		const canonicalCandidate = fs.existsSync(resolvedCandidate) ? fs.realpathSync.native(resolvedCandidate) : resolvedCandidate;
		const relative = path.relative(canonicalRoot, canonicalCandidate);
		return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	} catch { return false; }
}

const TOP_LEVEL_ARTIFACTS = Object.freeze([
	{ id: "memory-summary", name: "memory_summary.md", kind: "file", type: "summary" },
	{ id: "memory-handbook", name: "MEMORY.md", kind: "file", type: "handbook" },
	{ id: "raw-memories", name: "raw_memories.md", kind: "file", type: "raw-memories" },
	{ id: "rollout-summaries", name: "rollout_summaries", kind: "directory", type: "rollout-summaries" },
	{ id: "memory-skills", name: "skills", kind: "directory", type: "skills" },
]);

function childArtifactId(prefix, relativeName) {
	return `${prefix}-file-${crypto.createHash("sha256").update(relativeName).digest("hex").slice(0, 24)}`;
}

function regularFileMetadata(root, relativeName, id, type, consistency = "published") {
	const file = path.join(root, ...relativeName.split("/"));
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || !isContained(root, file)) return null;
		return { id, name: relativeName, kind: "file", type, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), itemCount: null, status: consistency === "mismatch" ? "degraded" : "healthy", consistency, file };
	} catch { return null; }
}

function expectedRollouts(observatory) {
	const expected = new Map();
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return expected;
	for (const row of observatory.db.prepare(`SELECT session_id,source_updated_at,rollout_slug,substr(CAST(rollout_summary AS BLOB),1,?) AS rollout_summary,length(CAST(rollout_summary AS BLOB)) AS rollout_summary_bytes FROM phase1_outputs WHERE selected_for_phase2=1`).all(DEFAULT_CONTENT_BYTES + 1)) {
		expected.set(`${rolloutStem(row)}.md`, { ...row, rollout_summary_too_large: Number(row.rollout_summary_bytes) > DEFAULT_CONTENT_BYTES });
	}
	return expected;
}

function enumerateRolloutArtifacts(observatory) {
	const root = path.join(observatory.memoryDir, "rollout_summaries");
	const expected = expectedRollouts(observatory); const entries = []; const actual = new Set();
	try {
		if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || !isContained(observatory.memoryDir, root)) return entries;
		for (const name of fs.readdirSync(root).filter((item) => item.endsWith(".md")).sort()) {
			const row = expected.get(name); let consistency = row ? "unknown" : "orphaned";
			if (row && !row.rollout_summary_too_large) consistency = expectedRolloutFile(observatory, { ...row, rollout_summary: Buffer.from(row.rollout_summary ?? []).toString("utf8") }).consistency;
			const item = regularFileMetadata(root, name, childArtifactId("rollout", name), "rollout-summary", consistency);
			if (item) { entries.push(item); actual.add(name); }
		}
	} catch {}
	for (const [name] of expected) if (!actual.has(name)) entries.push({ id: childArtifactId("rollout", name), name, kind: "file", type: "rollout-summary", exists: false, bytes: 0, modifiedAt: null, itemCount: null, status: "missing", consistency: "missing" });
	return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function enumerateSkillArtifacts(observatory) {
	const root = path.join(observatory.memoryDir, "skills"); const entries = [];
	function visit(directory, prefix = "") {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.isSymbolicLink()) continue;
			const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
			const candidate = path.join(directory, entry.name);
			if (entry.isDirectory()) { if (isContained(root, candidate)) visit(candidate, relativeName); continue; }
			if (!entry.isFile()) continue;
			const item = regularFileMetadata(root, relativeName, childArtifactId("skill", relativeName), "skill-file");
			if (item) entries.push(item);
		}
	}
	try {
		const stat = fs.lstatSync(root);
		if (stat.isDirectory() && !stat.isSymbolicLink() && isContained(observatory.memoryDir, root)) visit(root);
	} catch {}
	return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function directoryMetadata(observatory, definition, entries) {
	const directory = path.join(observatory.memoryDir, definition.name); let stat = null;
	try { const candidate = fs.lstatSync(directory); if (candidate.isDirectory() && !candidate.isSymbolicLink() && isContained(observatory.memoryDir, directory)) stat = candidate; } catch {}
	const consistency = !stat ? "missing" : entries.some((item) => ["missing", "mismatch", "orphaned"].includes(item.consistency)) ? "mismatch" : entries.some((item) => item.consistency === "unknown") ? "unknown" : "consistent";
	const existing = entries.filter((item) => item.exists);
	return { ...definition, exists: Boolean(stat), bytes: existing.reduce((sum, item) => sum + (item.bytes || 0), 0), modifiedAt: stat?.mtime.toISOString() ?? null, itemCount: existing.length, status: !stat ? "missing" : consistency === "mismatch" ? "degraded" : "healthy", consistency, directory };
}

function artifactRows(observatory) {
	const rollouts = enumerateRolloutArtifacts(observatory); const skills = enumerateSkillArtifacts(observatory);
	return TOP_LEVEL_ARTIFACTS.map((definition) => {
		if (definition.kind === "directory") return directoryMetadata(observatory, definition, definition.id === "rollout-summaries" ? rollouts : skills);
		const consistency = definition.id === "raw-memories" ? (() => { const file = path.join(observatory.memoryDir, definition.name); return fs.existsSync(file) && isContained(observatory.memoryDir, file) ? rawMemoriesConsistency(observatory, file) : "missing"; })() : "published";
		return regularFileMetadata(observatory.memoryDir, definition.name, definition.id, definition.type, consistency) ?? { ...definition, exists: false, bytes: 0, modifiedAt: null, itemCount: null, status: "missing", consistency: "missing" };
	});
}

function artifactEntries(observatory, id) {
	if (id === "rollout-summaries") return enumerateRolloutArtifacts(observatory);
	if (id === "memory-skills") return enumerateSkillArtifacts(observatory);
	return null;
}

function rawMemoriesConsistency(observatory, file) {
	if (!assertOpen(observatory) || !observatory.capabilities.features.phase1) return "unknown";
	const document = readFileHeadBounded(file);
	if (document.truncated) return "unknown";
	const selected = observatory.db.prepare("SELECT session_id,source_updated_at,substr(CAST(raw_memory AS BLOB),1,?) AS raw_memory,length(CAST(raw_memory AS BLOB)) AS raw_memory_bytes FROM phase1_outputs WHERE selected_for_phase2=1").all(DEFAULT_CONTENT_BYTES + 1);
	if (selected.some((row) => Number(row.raw_memory_bytes) > DEFAULT_CONTENT_BYTES)) return "unknown";
	return selected.every((row) => document.text.includes(`Session \`${row.session_id}\``) && document.text.includes(`updated_at: ${new Date(Number(row.source_updated_at)).toISOString()}\n`) && document.text.includes(Buffer.from(row.raw_memory ?? []).toString("utf8").trim())) ? "consistent" : "mismatch";
}

function summarizeArtifacts(items) {
	const summary = { total: items.length, consistent: 0, mismatched: 0, missing: 0, orphaned: 0, unknown: 0 };
	for (const item of items) {
		if (item.consistency === "consistent") summary.consistent++;
		else if (item.consistency === "mismatch") summary.mismatched++;
		else if (item.consistency === "missing") summary.missing++;
		else if (item.consistency === "orphaned") summary.orphaned++;
		else if (item.consistency !== "published") summary.unknown++;
	}
	summary.consistency = summary.mismatched || summary.missing || summary.orphaned ? "mismatch" : summary.unknown ? "unknown" : "consistent";
	return summary;
}

function artifactSummary(observatory) { return summarizeArtifacts(artifactRows(observatory)); }

function publicArtifact(item) {
	const { file, directory, ...metadata } = item;
	return metadata;
}

function queryArtifacts(observatory, options = {}) {
	const { limit, offset } = pageOptions(options); const all = artifactRows(observatory); const result = page(all.slice(offset, offset + limit + 1).map(publicArtifact), limit, offset); return { ...result, summary: summarizeArtifacts(all) };
}

function findArtifact(observatory, id) {
	const topLevel = artifactRows(observatory).find((candidate) => candidate.id === id);
	if (topLevel) return topLevel;
	return [...enumerateRolloutArtifacts(observatory), ...enumerateSkillArtifacts(observatory)].find((candidate) => candidate.id === id);
}

function queryArtifactDetail(observatory, id) {
	const item = findArtifact(observatory, id);
	if (!item) throw Object.assign(new Error("Artifact not found"), { code: "ARTIFACT_NOT_FOUND" });
	const entries = artifactEntries(observatory, id);
	return { ...publicArtifact(item), ...(entries ? { entries: entries.filter((entry) => entry.exists).map(publicArtifact) } : {}) };
}

function sanitizeArtifactText(text) {
	return redactPaths(redactSecrets(text)).replace(/^(rollout_path|cwd):.*$/gmi, "$1: [REDACTED_PATH]");
}

function queryArtifactContent(observatory, id, options = {}) {
	const item = findArtifact(observatory, id);
	if (!item) throw Object.assign(new Error("Artifact content is not available"), { code: "ARTIFACT_NOT_FOUND" });
	if (item.kind !== "file" || !item.file) throw Object.assign(new Error("Directory artifact content is not available"), { code: "ARTIFACT_NOT_FOUND" });
	if (!isContained(observatory.memoryDir, item.file)) throw Object.assign(new Error("Invalid artifact path"), { code: "INVALID_ARTIFACT" });
	const maxBytes = clampInteger(options.maxBytes, DEFAULT_CONTENT_BYTES, 0, 16 * 1024 * 1024);
	const document = readFileHeadBounded(item.file, Math.min(16 * 1024 * 1024, maxBytes + 512));
	const sanitized = boundedString(sanitizeArtifactText(document.text), maxBytes);
	return { id: item.id, name: item.name, kind: item.kind, type: item.type, consistency: item.consistency, content: sanitized.content, bytes: sanitized.bytes, totalBytes: document.totalBytes, truncated: document.totalBytes > maxBytes || sanitized.truncated };
}

function readTail(file, maxBytes) {
	const size = fs.statSync(file).size; const length = Math.min(size, maxBytes); const buffer = Buffer.alloc(length); const fd = fs.openSync(file, "r");
	try { if (length) fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
	let text = buffer.toString("utf8"); if (size > length) text = text.slice(text.indexOf("\n") + 1); return { text, bytes: length, truncated: size > length };
}

function queryLogs(observatory, options = {}) {
	const lineCount = clampInteger(options.lines, 50, 1, MAX_LIMIT); const maxBytes = clampInteger(options.maxBytes, DEFAULT_LOG_BYTES, 1, 4 * 1024 * 1024);
	const file = path.join(observatory.memoryDir, "worker.log");
	if (!isContained(observatory.memoryDir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { lines: [], lineCount, bytes: 0, truncated: false };
	const tail = readTail(file, maxBytes); const lines = tail.text.split(/\r?\n/).filter(Boolean).slice(-lineCount).map(sanitizeDiagnosticText);
	return { lines, lineCount, bytes: tail.bytes, truncated: tail.truncated || tail.text.split(/\r?\n/).filter(Boolean).length > lines.length };
}

module.exports = {
	DEFAULT_LIMIT, MAX_LIMIT, openMemoryObservatory, probeCapabilities, deriveWorkerState, deriveJobState,
	queryOverview, queryWorkers, queryJobs, querySessions, queryPhase1, queryPhase1Detail, queryPhase1Content,
	queryPhase2, queryArtifacts, queryArtifactDetail, queryArtifactContent, queryLogs, sanitizeDiagnosticText,
};
