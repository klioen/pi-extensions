#!/usr/bin/env node
/**
 * pi-memory worker — independent child process that polls the memory SQLite
 * job queue and executes phase-1 / phase-2 memory distillation jobs.
 *
 * Phase 2 (consolidation) is modeled after Codex:
 *   - global singleton job (kind='memory_consolidate_global'), claimed with a
 *     lease + ownership token; success cooldown (6h) and retry backoff (1h)
 *   - executed by a full agent: we fork a `pi --print` child with read/grep/
 *     bash/edit/write tools so the consolidation agent reads the memory
 *     workspace and edits MEMORY.md / memory_summary.md itself
 *   - a watermark pre-check avoids calling the LLM when there is no new input
 *
 * Runs detached from the pi process (child_process.fork), so it survives pi
 * exiting in print/CI mode. Config arrives via IPC from the parent.
 */
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
	SCHEMA,
	phase1Prompt,
	parseJsonObj,
	redactSecrets,
	sessionTranscriptFromJsonl,
	heartbeatWorkerLease,
	releaseWorkerLease,
	upsertPhase1Job,
	pendingSessionScan,
	completeSessionScan,
	selectIdleSessions,
	resolveRolloutTokenBudget,
	phase1PiArgs,
	phase2Prompt,
	phase2PiArgs,
	PHASE2_WORKSPACE_DIFF_FILE,
	PHASE2_WORKSPACE_DIFF_MAX_BYTES,
} = require(path.join(__dirname, "..", "lib", "memory-core.cjs"));

const WORKER_ID = `w-${process.pid}`;
const POLL_MS_DEFAULT = 60_000; // fallback interval when nothing is due (codex: work is triggered, not polled)
const LEASE_MS = 60 * 60 * 1000;        // 1h lease (codex JOB_LEASE_SECONDS=3600); idempotent retry makes it safe
const RETRY_DELAY_MS = 60 * 60 * 1000;  // 1h retry backoff (codex JOB_RETRY_DELAY_SECONDS)
const PHASE2_SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown (codex)
const PHASE1_AGENT_TIMEOUT_MS = Math.max(30_000, Number(process.env.PI_MEMORY_PHASE1_TIMEOUT_MS) || 10 * 60 * 1000);
const PHASE2_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const PHASE2_HEARTBEAT_MS = 90 * 1000;
const CONCURRENCY = Math.max(1, Number(process.env.PI_MEMORY_PHASE1_CONCURRENCY) || 8); // codex default = 8
const MIN_ROLLOUT_IDLE_MS = (process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS === undefined ? 6 : Number(process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS)) * 3600 * 1000; // codex default 6h; explicit 0 disables the idle gate
const MAX_UNUSED_DAYS = Math.max(1, Number(process.env.PI_MEMORY_MAX_UNUSED_DAYS) || 30); // codex default = 30

let cfg = null;
let db = null;
let polling = false;
let coordinatorActive = false;
let coordinatorTimer = null;

function log(...args) { console.error(`[pi-memory-worker]`, ...args); }
// Normal operation is quiet; only errors and key state changes hit the footer.
// Set PI_MEMORY_DEBUG=1 to see the full noisy trace.
function debug(...args) {
	if (process.env.PI_MEMORY_DEBUG === "1") console.error(`[pi-memory-worker]`, ...args);
}

function openDb() {
	db = new DatabaseSync(cfg.dbPath);
	db.exec("PRAGMA busy_timeout=5000;");
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(SCHEMA);
	for (const sql of [
		"ALTER TABLE phase1_outputs ADD COLUMN generated_at INTEGER",
		"ALTER TABLE phase1_outputs ADD COLUMN rollout_path TEXT",
		"ALTER TABLE phase1_outputs ADD COLUMN selected_for_phase2 INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE phase1_outputs ADD COLUMN selected_for_phase2_source_updated_at INTEGER",
	]) {
		try { db.exec(sql); } catch { /* already migrated */ }
	}
	db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

function kvGet(key, fallback = null) {
	const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
	return row ? JSON.parse(row.value) : fallback;
}
function kvSet(key, value) {
	db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

// ---- session index + phase-1 job discovery ----

function discoverPhase1Jobs() {
	const scan = pendingSessionScan(db);
	if (!scan) return 0;
	const candidates = selectIdleSessions(
		db,
		scan.current_session_id || "",
		Date.now(),
		Number(cfg.minRolloutIdleMs) || MIN_ROLLOUT_IDLE_MS,
		Number(cfg.maxRolloutAgeMs) || 10 * 24 * 3600 * 1000,
		Number(cfg.scanLimit) || 5000,
	);
	let enqueued = 0;
	const max = Math.max(1, Number(cfg.maxRolloutsPerStartup) || 2);
	for (const session of candidates) {
		if (enqueued >= max) break;
		if (upsertPhase1Job(db, session.session_id, session.updated_at, {
			rolloutPath: session.rollout_path,
			sessionId: session.session_id,
		})) enqueued++;
	}
	completeSessionScan(db, scan.requested_generation);
	return enqueued;
}

// ---- phase-1 job helpers ----

function claimPhase1Jobs() {
	const now = Date.now();
	// Codex min_rollout_idle_hours: a rollout is only extracted once the
	// conversation has been idle for MIN_ROLLOUT_IDLE_HOURS. The job carries
	// input_watermark = timestamp of the last message; we only claim it once
	// now - watermark >= idle window. Jobs stay pending until then — matching
	// codex's "next startup extracts idle history" behavior (stability over
	// realtime).
	const idleCutoff = now - MIN_ROLLOUT_IDLE_MS;
	const allRows = db.prepare(
		`SELECT * FROM jobs
       WHERE kind = 'phase1'
         AND retry_remaining > 0
         AND (
           status = 'pending'
           OR (status = 'failed' AND retry_until IS NOT NULL AND retry_until <= ?)
           OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?)
         )
       ORDER BY created_at ASC LIMIT ?`,
	).all(now, now, CONCURRENCY);
	// Drop not-yet-idle jobs (keep them pending for a later poll).
	const rows = allRows.filter((row) => {
		if (!row.input_watermark) return true; // no ts → no idle gate (legacy)
		return row.input_watermark <= idleCutoff;
	});
	// Codex idempotency: skip jobs whose input_watermark is already covered by
	// phase1_outputs.source_updated_at (SkippedUpToDate). A retried or duplicate
	// phase-1 job then marks completed without re-running the LLM.
	const upToDate = rows.filter((row) => {
		if (!row.input_watermark) return false;
		const output = db.prepare(`SELECT source_updated_at FROM phase1_outputs WHERE session_id = ?`).get(row.job_key);
		return output && Number(output.source_updated_at) >= Number(row.input_watermark);
	});
	for (const row of upToDate) {
		// Claim only if the row is still unowned/expired. Never overwrite a
		// concurrent worker's fresh lease just because this scanner saw an older
		// snapshot of the row.
		const completed = db.prepare(
			`UPDATE jobs SET status='completed', finished_at=?
			 WHERE kind='phase1' AND job_key=?
			   AND (status='pending'
			        OR (status='failed' AND retry_until IS NOT NULL AND retry_until <= ?)
			        OR (status='leased' AND lease_until IS NOT NULL AND lease_until <= ?))`,
		).run(Date.now(), row.job_key, now, now);
		if (completed.changes > 0) debug(`phase1 ${row.job_key}: up-to-date (watermark ${row.input_watermark}), skipping`);
	}
	const eligible = rows.filter((row) => !upToDate.includes(row));
	const stmt = db.prepare(
		`UPDATE jobs SET status='leased', worker_id=?, ownership_token=?, lease_until=?
		 WHERE kind='phase1' AND job_key=? AND retry_remaining > 0
		   AND (
		     status='pending'
		     OR (status='failed' AND retry_until IS NOT NULL AND retry_until <= ?)
		     OR (status='leased' AND lease_until IS NOT NULL AND lease_until <= ?)
		   )`,
	);
	const claimed = [];
	for (const row of eligible) {
		const token = `${WORKER_ID}-${row.job_key}-${Date.now()}`;
		if (stmt.run(WORKER_ID, token, now + LEASE_MS, row.job_key, now, now).changes > 0) {
			row.ownership_token = token;
			claimed.push(row);
		}
	}
	return claimed;
}

function markCompleted(row) {
	db.prepare(
		`UPDATE jobs SET status='completed', finished_at=?, lease_until=NULL WHERE kind=? AND job_key=? AND ownership_token=?`,
	).run(Date.now(), row.kind, row.job_key, row.ownership_token);
}

function markFailed(row, errMsg) {
	db.prepare(
		`UPDATE jobs SET status='failed', last_error=?, retry_until=?, retry_remaining=retry_remaining-1, lease_until=NULL
       WHERE kind=? AND job_key=? AND ownership_token=?`,
	).run(String(errMsg).slice(0, 2000), Date.now() + RETRY_DELAY_MS, row.kind, row.job_key, row.ownership_token);
}

// ---- phase-2 global singleton (mirrors codex try_claim_global_phase2_job) ----

const P2_KIND = "memory_consolidate_global";
const P2_KEY = "consolidation";
const P2_WATERMARK = "phase2_last_watermark";

/** Enqueue / advance the global phase-2 job watermark (called after phase-1 success). */
function enqueuePhase2() {
	const now = Date.now();
	const existing = db.prepare(`SELECT status, lease_until, retry_until, last_error, finished_at FROM jobs WHERE kind=? AND job_key=?`).get(P2_KIND, P2_KEY);
	if (!existing) {
		db.prepare(
			`INSERT INTO jobs (kind, job_key, status, retry_remaining, payload, input_watermark, created_at)
       VALUES (?, ?, 'pending', 3, '{}', ?, ?)`,
		).run(P2_KIND, P2_KEY, now, now);
		return;
	}
	// manual force (from /memory consolidate): reset completed→pending so the
	// next claim runs immediately (cooldown still applies unless force set)
	const payloadRow = db.prepare(`SELECT payload FROM jobs WHERE kind=? AND job_key=?`).get(P2_KIND, P2_KEY);
	let force = false;
	try { force = !!JSON.parse(payloadRow?.payload ?? "{}").force; } catch { force = false; }
	if (force) {
		kvSet("phase2_last_success_at", 0); // bypass 6h cooldown for manual runs
		db.prepare(`UPDATE jobs SET status='pending', lease_until=NULL, finished_at=NULL, payload='{"force":true}' WHERE kind=? AND job_key=?`).run(P2_KIND, P2_KEY);
	}
	// advance watermark on the pending row (or any non-running row)
	if (existing.status !== "running" || (existing.lease_until ?? 0) <= now) {
		db.prepare(`UPDATE jobs SET input_watermark = ?, last_error = NULL, retry_until = NULL WHERE kind=? AND job_key=?`).run(now, P2_KIND, P2_KEY);
	}
}

function claimPhase2() {
	const now = Date.now();
	const cooldownCutoff = now - PHASE2_SUCCESS_COOLDOWN_MS;
	const row = db.prepare(`SELECT * FROM jobs WHERE kind=? AND job_key=?`).get(P2_KIND, P2_KEY);
	if (!row) return { outcome: "no_job" };
	const steal = (statusWhere) => {
		const token = `${WORKER_ID}-p2-${now}`;
		const upd = db.prepare(
			`UPDATE jobs SET status='running', worker_id=?, ownership_token=?, lease_until=?, started_at=?, last_error=NULL
       WHERE kind=? AND job_key=? AND ${statusWhere}`,
		).run(WORKER_ID, token, now + LEASE_MS, now, P2_KIND, P2_KEY);
		if (upd.changes === 0) return { outcome: "skipped_running" };
		const fresh = db.prepare(`SELECT * FROM jobs WHERE kind=? AND job_key=?`).get(P2_KIND, P2_KEY);
		return { outcome: "claimed", row: fresh };
	};
	if (row.status === "pending") {
		const lastSuccess = kvGet("phase2_last_success_at", 0);
		if (lastSuccess > cooldownCutoff) return { outcome: "skipped_cooldown" };
		return steal("status='pending'");
	}
	if (row.status === "running") {
		if ((row.lease_until ?? 0) > now) return { outcome: "skipped_running" };
		return steal("status='running'"); // lease expired → steal
	}
	if (row.status === "failed") {
		if ((row.retry_until ?? 0) > now) return { outcome: "skipped_retry_backoff" };
		return steal("status='failed'");
	}
	if (row.status === "completed") {
		const lastSuccess = kvGet("phase2_last_success_at", 0);
		if (lastSuccess <= cooldownCutoff) {
			// Codex claims after cooldown and lets the materialized git workspace,
			// rather than a DB watermark, decide whether consolidation has work.
			db.prepare(`UPDATE jobs SET status='pending', lease_until=NULL, finished_at=NULL WHERE kind=? AND job_key=?`).run(P2_KIND, P2_KEY);
			return { outcome: "recycled" };
		}
		return { outcome: "skipped_cooldown" };
	}
	return { outcome: "no_job" };
}

function markPhase2Failed(row, errMsg) {
	debug("markPhase2Failed row:", JSON.stringify(row));
	db.prepare(
		`UPDATE jobs SET status='failed', finished_at=?, last_error=?, retry_until=?,
		 retry_remaining=MAX(retry_remaining-1, 0), lease_until=NULL
       WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`,
	).run(Date.now(), String(errMsg).slice(0, 2000), Date.now() + RETRY_DELAY_MS, P2_KIND, P2_KEY, row.ownership_token);
}

function heartbeatPhase2(row) {
	return db.prepare(
		`UPDATE jobs SET lease_until=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`,
	).run(Date.now() + LEASE_MS, P2_KIND, P2_KEY, row.ownership_token).changes > 0;
}

function markPhase2Completed(row, selected) {
	debug("markPhase2Completed row:", JSON.stringify(row));
	const now = Date.now();
	const latestSource = selected.reduce((max, memory) => Math.max(max, Number(memory.source_updated_at) || 0), Number(row.input_watermark) || 0);
	db.exec("BEGIN IMMEDIATE");
	try {
		const updated = db.prepare(
			`UPDATE jobs SET status='completed', finished_at=?, lease_until=NULL,
			 last_success_watermark=MAX(COALESCE(last_success_watermark, 0), ?)
			 WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`,
		).run(now, latestSource, P2_KIND, P2_KEY, row.ownership_token);
		if (updated.changes === 0) throw new Error("lost global phase2 ownership before completion");
		db.prepare(`UPDATE phase1_outputs SET selected_for_phase2=0, selected_for_phase2_source_updated_at=NULL`).run();
		const markSelected = db.prepare(
			`UPDATE phase1_outputs SET selected_for_phase2=1, selected_for_phase2_source_updated_at=?
			 WHERE session_id=? AND source_updated_at=?`,
		);
		for (const memory of selected) markSelected.run(memory.source_updated_at, memory.session_id, memory.source_updated_at);
		db.prepare(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run("phase2_last_success_at", String(now));
		db.prepare(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(P2_WATERMARK, String(latestSource));
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

// ---- phase-1 executor ----

function ensureLayout() {
	for (const p of [cfg.memDir, path.join(cfg.memDir, "rollout_summaries"), path.join(cfg.memDir, "skills")]) {
		fs.mkdirSync(p, { recursive: true });
	}
	const sf = path.join(cfg.memDir, "memory_summary.md");
	const mf = path.join(cfg.memDir, "MEMORY.md");
	const rf = path.join(cfg.memDir, "raw_memories.md");
	if (!fs.existsSync(sf)) fs.writeFileSync(sf, "v1\n\n## User Profile\n\n(empty)\n");
	if (!fs.existsSync(mf)) fs.writeFileSync(mf, "# MEMORY\n\n(empty)\n");
	if (!fs.existsSync(rf)) fs.writeFileSync(rf, "# Raw Memories\n\n");
}

function memoryChildEnv() {
	return {
		...process.env,
		PI_MEMORY_DIR: cfg.memDir,
		PI_MEMORY_DB: cfg.dbPath,
		PI_MEMORY_AUTO: "0",
		PI_MEMORY_RECALL: "0",
		PI_MEMORY_AGENT_CHILD: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
}

function runPhase1WithPi(prompt) {
	const modelSpec = cfg.llm?.model;
	const args = phase1PiArgs(modelSpec);
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { env: memoryChildEnv(), cwd: cfg.memDir, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error("phase1 pi runtime timed out"));
		}, PHASE1_AGENT_TIMEOUT_MS);
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
		child.stdin.on("error", () => { /* exit/error handler reports the failure */ });
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0 && stdout.trim()) resolve(stdout.trim());
			else reject(new Error(`phase1 pi exited ${code}: ${stderr.trim() || stdout.trim() || "empty response"}`));
		});
		child.stdin.end(prompt);
	});
}

// Codex phase-1 writes only to SQLite (phase1_outputs); rollout summary files
// are materialized later by phase-2 (sync_rollout_summaries_from_memories).
async function runPhase1(row) {
	const payload = JSON.parse(row.payload);
	let transcript = payload.transcript; // backward compatibility with old queued jobs
	let rolloutCwd = typeof payload.rolloutCwd === "string" ? payload.rolloutCwd : "";
	if (typeof payload.rolloutPath === "string" && fs.existsSync(payload.rolloutPath)) {
		// Codex loads the full stable rollout AFTER claim. Do the same instead of
		// relying on a scanner-time tail snapshot.
		const rolloutTokenBudget = resolveRolloutTokenBudget(cfg.llm?.contextWindow);
		const parsedSession = sessionTranscriptFromJsonl(fs.readFileSync(payload.rolloutPath, "utf8"), rolloutTokenBudget);
		transcript = parsedSession.transcript;
		rolloutCwd = parsedSession.cwd || rolloutCwd || path.dirname(payload.rolloutPath);
	}
	if (!transcript || !String(transcript).trim()) throw new Error("rollout transcript unavailable or empty");
	const prompt = phase1Prompt(String(transcript), typeof payload.rolloutPath === "string" ? payload.rolloutPath : "", rolloutCwd);
	let raw = await runPhase1WithPi(prompt);
	let parsed = parseJsonObj(raw);
	if (!parsed) {
		// Models occasionally return prose or a truncated object despite the
		// prompt. Retry once with an explicit repair instruction before failing.
		const retryPrompt = `${prompt}\n\nYour previous response was invalid. Return ONLY one valid JSON object with string fields raw_memory, rollout_summary, rollout_slug. Do not explain.`;
		raw = await runPhase1WithPi(retryPrompt);
		parsed = parseJsonObj(raw);
	}
	if (!parsed || typeof parsed !== "object") {
		debug(`phase1 ${row.job_key}: invalid LLM response (${String(raw).length} chars): ${redactSecrets(String(raw)).slice(0, 500)}`);
		throw new Error(`phase1 LLM output unparseable or empty (response ${String(raw).length} chars after retry)`);
	}
	// Codex treats an incomplete phase1 result as no-output, not a retryable
	// failure. Normalize every SQLite-bound value so malformed optional fields
	// can never pass undefined into node:sqlite.
	const rawMemory = redactSecrets(typeof parsed.raw_memory === "string" ? parsed.raw_memory : "").trim();
	const rolloutSummary = redactSecrets(typeof parsed.rollout_summary === "string" ? parsed.rollout_summary : "").trim();
	if (!rawMemory || !rolloutSummary) {
		debug(`phase1 ${row.job_key}: valid but empty/incomplete output; completing without phase1 row`);
		return;
	}
	const rolloutSlug = typeof parsed.rollout_slug === "string" && parsed.rollout_slug.trim()
		? redactSecrets(parsed.rollout_slug.trim())
		: null;
	const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : row.job_key;
	const sourceUpdatedAt = Number(row.input_watermark) || Date.now(); // codex: source_updated_at = input watermark
	const cwd = typeof rolloutCwd === "string" ? rolloutCwd : "";
	db.prepare(
		`INSERT INTO phase1_outputs (session_id, source_updated_at, raw_memory, rollout_summary, generated_at, rollout_slug, cwd, rollout_path, usage_count, last_usage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(session_id) DO UPDATE SET source_updated_at=excluded.source_updated_at, raw_memory=excluded.raw_memory,
       rollout_summary=excluded.rollout_summary, generated_at=excluded.generated_at,
       rollout_slug=excluded.rollout_slug, cwd=excluded.cwd, rollout_path=excluded.rollout_path`,
	).run(sessionId, sourceUpdatedAt, rawMemory, rolloutSummary, Date.now(), rolloutSlug, cwd,
		typeof payload.rolloutPath === "string" ? payload.rolloutPath : "");
	debug(`phase1 done: ${sessionId} -> phase1_outputs (watermark ${sourceUpdatedAt})`);
	// phase-1 success advances the phase-2 watermark (codex: enqueue_global_consolidation)
	enqueuePhase2();
}

// ---- phase-2 executor: run a full pi agent (with tools) ----

// Codex-aligned git baseline for the memory workspace.
// - ensure the memories root is a git repo with an initial baseline commit
//   (codex: prepare_memory_workspace)
// - workspaceHasChanges() mirrors codex's memory_workspace_diff().has_changes():
//   phase 2 is skipped (no LLM) when the workspace is clean
// - resetMemoryBaseline() commits a fresh baseline after a successful
//   consolidation (codex: reset_memory_workspace_baseline)
function git(cmd) {
	const { execFileSync } = require("node:child_process");
	return execFileSync("git", ["-C", cfg.memDir, ...cmd], { encoding: "utf8", timeout: 10000 });
}

function resetGitRepository() {
	fs.rmSync(path.join(cfg.memDir, ".git"), { force: true, recursive: true });
	git(["init", "-q"]);
	git(["config", "user.name", "pi-memory"]);
	git(["config", "user.email", "pi-memory@localhost"]);
	git(["add", "-A"]);
	git(["commit", "--allow-empty", "-qm", "memory baseline"]);
}

function prepareMemoryWorkspace() {
	if (fs.existsSync(cfg.memDir) && fs.lstatSync(cfg.memDir).isSymbolicLink()) {
		throw new Error(`memory root cannot be a symbolic link: ${cfg.memDir}`);
	}
	ensureLayout();
	removeMemorySymlinks(cfg.memDir);
	fs.rmSync(path.join(cfg.memDir, PHASE2_WORKSPACE_DIFF_FILE), { force: true });
	const gitignore = path.join(cfg.memDir, ".gitignore");
	const requiredIgnores = ["memory.db", "memory.db-wal", "memory.db-shm", "worker.log"];
	const existingIgnores = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8").split(/\r?\n/) : [];
	const mergedIgnores = [...existingIgnores.filter(Boolean)];
	for (const entry of requiredIgnores) if (!mergedIgnores.includes(entry)) mergedIgnores.push(entry);
	fs.writeFileSync(gitignore, `${mergedIgnores.join("\n")}\n`);
	try {
		git(["rev-parse", "--verify", "HEAD"]);
	} catch {
		resetGitRepository();
		log("memory workspace git baseline initialized");
	}
}

function memoryWorkspaceDiff() {
	fs.rmSync(path.join(cfg.memDir, PHASE2_WORKSPACE_DIFF_FILE), { force: true });
	const status = git(["status", "--porcelain", "--untracked-files=all"]);
	let unifiedDiff = git(["diff", "--no-ext-diff", "--binary", "HEAD", "--", "."]);
	for (const line of status.split("\n")) {
		if (!line.startsWith("?? ")) continue;
		const relative = line.slice(3);
		const absolute = path.join(cfg.memDir, relative);
		if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
		const content = fs.readFileSync(absolute, "utf8");
		unifiedDiff += `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${content.split("\n").length} @@\n`;
		unifiedDiff += content.split("\n").map((entry) => `+${entry}`).join("\n") + "\n";
	}
	return { status, unifiedDiff, hasChanges: status.trim().length > 0 };
}

function writeWorkspaceDiff(diff) {
	let rendered = "# Memory Workspace Diff\n\nGenerated by pi before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n## Status\n";
	if (!diff.hasChanges) rendered += "- none\n";
	else {
		for (const line of diff.status.trimEnd().split("\n")) rendered += `- ${line}\n`;
		rendered += "\n## Diff\n\n```diff\n";
		const bounded = Buffer.byteLength(diff.unifiedDiff) <= PHASE2_WORKSPACE_DIFF_MAX_BYTES
			? diff.unifiedDiff
			: Buffer.from(diff.unifiedDiff).subarray(0, PHASE2_WORKSPACE_DIFF_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "")
				+ `\n[workspace diff truncated at ${PHASE2_WORKSPACE_DIFF_MAX_BYTES} bytes]\n`;
		rendered += bounded + (bounded.endsWith("\n") ? "" : "\n") + "```\n";
	}
	fs.writeFileSync(path.join(cfg.memDir, PHASE2_WORKSPACE_DIFF_FILE), rendered);
}

function removeMemorySymlinks(root) {
	let removed = 0;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const target = path.join(root, entry.name);
		if (entry.isSymbolicLink()) { fs.rmSync(target, { force: true, recursive: false }); removed++; }
		else if (entry.isDirectory()) removed += removeMemorySymlinks(target);
	}
	return removed;
}

function validateConsolidationArtifacts() {
	const removed = removeMemorySymlinks(cfg.memDir);
	if (removed > 0) throw new Error(`removed ${removed} symbolic links from consolidated memory workspace`);
	const memoryPath = path.join(cfg.memDir, "MEMORY.md");
	if (!fs.existsSync(memoryPath) || !fs.statSync(memoryPath).isFile()) throw new Error("MEMORY.md is missing or not a file");
	const summaryPath = path.join(cfg.memDir, "memory_summary.md");
	if (!fs.existsSync(summaryPath) || !fs.statSync(summaryPath).isFile()) throw new Error("memory_summary.md is missing or not a file");
	if (fs.readFileSync(summaryPath, "utf8").split(/\r?\n/, 1)[0] !== "v1") throw new Error("memory_summary.md does not start with v1");
}

function resetMemoryBaseline() {
	fs.rmSync(path.join(cfg.memDir, PHASE2_WORKSPACE_DIFF_FILE), { force: true });
	// Codex replaces .git rather than accumulating history, so deleted memory
	// content is not retained in unreachable commits.
	resetGitRepository();
	log("memory workspace baseline reset");
}

const MAX_RAW_FOR_CONSOLIDATION = Math.max(1, Number(process.env.PI_MEMORY_MAX_RAW_CONSOLIDATION) || 256); // codex DEFAULT=256

// Codex sync_rollout_summaries_from_memories + rebuild_raw_memories_file:
// materialize the selected phase1_outputs (latest first, capped) into
// rollout_summaries/<stem>.md (one per thread; prune files no longer in the
// selection) and rebuild raw_memories.md as the merged input for phase 2.
function rolloutStem(m) {
	const ts = new Date(Number(m.source_updated_at) || Date.now()).toISOString().replace(/[:.]/g, "-").slice(0, 23);
	const slug = (m.rollout_slug || "rollout").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${ts}-${slug}-${String(m.session_id).slice(0, 8)}`;
}

function materializePhase2Inputs() {
	ensureLayout();
	// Codex get_phase2_input_selection: retain recently used outputs first,
	// otherwise recent never-used outputs; then stable source/thread ordering.
	const unusedCutoff = Date.now() - MAX_UNUSED_DAYS * 24 * 3600 * 1000;
	const selected = db.prepare(
		`SELECT * FROM phase1_outputs
		 WHERE (length(trim(raw_memory)) > 0 OR length(trim(rollout_summary)) > 0)
		   AND ((last_usage IS NOT NULL AND last_usage >= ?)
		        OR (last_usage IS NULL AND source_updated_at >= ?))
		 ORDER BY COALESCE(usage_count, 0) DESC,
		          COALESCE(last_usage, source_updated_at) DESC,
		          source_updated_at DESC, session_id DESC
		 LIMIT ?`,
	).all(unusedCutoff, unusedCutoff, MAX_RAW_FOR_CONSOLIDATION);
	// Preserve the exact previous successful selection until a newer successful
	// Phase 2 replaces it, matching Codex's retention baseline semantics.
	db.prepare(
		`DELETE FROM phase1_outputs
		 WHERE NOT (COALESCE(selected_for_phase2, 0) = 1
		            AND selected_for_phase2_source_updated_at = source_updated_at)
		   AND ((last_usage IS NOT NULL AND last_usage < ?)
		        OR (last_usage IS NULL AND source_updated_at < ?))`,
	).run(unusedCutoff, unusedCutoff);

	// prune rollout summaries not in the selection (codex prune_rollout_summaries)
	const keep = new Set(selected.map((m) => rolloutStem(m)));
	const dir = path.join(cfg.memDir, "rollout_summaries");
	if (fs.existsSync(dir)) {
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			const stem = f.replace(/\.md$/, "");
			if (!keep.has(stem)) fs.rmSync(path.join(dir, f));
		}
	}

	// write one summary file per thread
	for (const m of selected) {
		const stem = rolloutStem(m);
		fs.writeFileSync(
			path.join(dir, `${stem}.md`),
			[
				`session_id: ${m.session_id}`,
				`updated_at: ${new Date(Number(m.source_updated_at)).toISOString()}`,
				`rollout_path: ${m.rollout_path || ""}`,
				`cwd: ${m.cwd || ""}`,
				...(m.git_branch ? [`git_branch: ${m.git_branch}`] : []),
				``,
				m.rollout_summary || "",
				``,
			].join("\n"),
		);
	}

	// rebuild raw_memories.md (merged, stable ascending session-id order)
	let body = "# Raw Memories\n\n";
	if (selected.length === 0) body += "No raw memories yet.\n";
	else {
		body += "Merged phase-1 raw memories (stable ascending session-id order):\n\n";
		const asc = [...selected].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
		for (const m of asc) {
			body += `## Session \`${m.session_id}\`\n`;
			body += `updated_at: ${new Date(Number(m.source_updated_at)).toISOString()}\n`;
			body += `cwd: ${m.cwd || ""}\n`;
			body += `rollout_path: ${m.rollout_path || ""}\n`;
			body += `rollout_summary_file: rollout_summaries/${rolloutStem(m)}.md\n\n`;
			body += (m.raw_memory || "").trim() + "\n\n";
		}
	}
	fs.writeFileSync(path.join(cfg.memDir, "raw_memories.md"), body);
	log(`phase2 inputs materialized: ${selected.length} phase1_outputs -> rollout_summaries/ + raw_memories.md`);
	return selected;
}

function resolvePhase2ProviderExtension(modelSpec) {
	if (typeof modelSpec !== "string" || !modelSpec.startsWith("traex/")) return undefined;
	const searchRoot = path.join(process.env.HOME || "", ".pi", "agent", "npm", "node_modules");
	try {
		return require.resolve("@bytedance-dev/pi-provider-traex", { paths: [searchRoot] });
	} catch (error) {
		throw new Error(`cannot resolve TraeX provider extension: ${error.message}`);
	}
}

async function runPhase2AsAgent(row) {
	prepareMemoryWorkspace();
	const selected = materializePhase2Inputs();
	const workspaceDiff = memoryWorkspaceDiff();
	if (!workspaceDiff.hasChanges) {
		try {
			validateConsolidationArtifacts();
			debug("phase2: no workspace changes and artifacts are valid; skipping LLM");
			markPhase2Completed(row, selected);
			return;
		} catch (error) {
			debug("phase2: clean workspace has invalid artifacts; running agent:", error.message);
		}
	}
	writeWorkspaceDiff(workspaceDiff);

	const modelSpec = cfg.llm.phase2Model || cfg.llm.model;
	const prompt = phase2Prompt(cfg.memDir);
	const env = {
		...process.env,
		PI_MEMORY_DIR: cfg.memDir,
		PI_MEMORY_AUTO: "0",
		PI_MEMORY_RECALL: "0",
		PI_MEMORY_AGENT_CHILD: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
	// Auto-discovery stays disabled. Load only the selected custom provider;
	// TraeX is an extension provider, while built-in providers need no entry.
	const providerExtension = resolvePhase2ProviderExtension(modelSpec);
	const args = phase2PiArgs(modelSpec, prompt, providerExtension);

	log(`phase2: spawning restricted pi agent (model=${modelSpec})`);
	const child = spawn("pi", args, { env, cwd: cfg.memDir, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	const result = await new Promise((resolve) => {
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(heartbeat);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, error: "phase2 agent timed out" });
		}, PHASE2_AGENT_TIMEOUT_MS);
		const heartbeat = setInterval(() => {
			try {
				if (!heartbeatPhase2(row)) {
					child.kill("SIGKILL");
					finish({ ok: false, error: "lost global phase2 ownership during heartbeat" });
				}
			} catch (error) {
				child.kill("SIGKILL");
				finish({ ok: false, error: `phase2 heartbeat failed: ${error.message}` });
			}
		}, PHASE2_HEARTBEAT_MS);
		heartbeat.unref?.();
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
		child.on("error", (error) => finish({ ok: false, error: String(error) }));
		child.on("exit", (code) => {
			if (code === 0) finish({ ok: true, stdout: stdout.slice(-2000) });
			else finish({ ok: false, error: `pi exited ${code}: ${stderr.slice(-500) || stdout.slice(-500)}` });
		});
	});

	if (!result.ok) {
		log("phase2 agent failed:", result.error);
		markPhase2Failed(row, result.error);
		return;
	}
	try {
		validateConsolidationArtifacts();
		if (!heartbeatPhase2(row)) throw new Error("lost global phase2 ownership before resetting workspace baseline");
		resetMemoryBaseline();
		markPhase2Completed(row, selected);
		log("phase2: consolidation agent finished");
	} catch (error) {
		log("phase2 validation/finalization failed:", error.message);
		markPhase2Failed(row, error.message);
	}
}

// ---- main loop ----

function nextWakeMs(now) {
	// Earliest moment any queued job becomes actionable:
	// - phase1: input_watermark + idle window (extract once the conversation is idle)
	// - phase2: retry_until backoff, or cooldown expiry
	// - fallback: default poll interval
	const idleMs = MIN_ROLLOUT_IDLE_MS;
	let earliest = now + Math.max(500, Number(cfg?.pollMs) || POLL_MS_DEFAULT);
	try {
		for (const row of db.prepare(
			`SELECT kind, status, input_watermark, retry_until FROM jobs WHERE status IN ('pending','failed')`,
		).all()) {
			if (row.kind === "phase1" && row.input_watermark) {
				const due = Number(row.input_watermark) + idleMs;
				if (due < earliest) earliest = due;
			}
			if (row.kind === "memory_consolidate_global") {
				if (row.status === "failed" && row.retry_until) {
					if (Number(row.retry_until) < earliest) earliest = Number(row.retry_until);
				}
			}
		}
	} catch { /* best-effort */ }
	return Math.max(earliest - now, 1000);
}

async function pollOnce() {
	if (!db || polling || !coordinatorActive) return 0;
	// Never claim new work unless this process can still renew the global lease.
	// A transient SQLite error skips this poll; a token mismatch schedules exit.
	if (!heartbeatCoordinator()) return 0;
	polling = true;
	let didWork = false;
	try {
		discoverPhase1Jobs();
		// Phase 1 jobs run concurrently (Codex buffer_unordered(CONCURRENCY_LIMIT)).
		const phase1 = claimPhase1Jobs();
		if (phase1.length > 0) didWork = true;
		await Promise.all(phase1.map(async (row) => {
			try { await runPhase1(row); markCompleted(row); }
			catch (err) { log(`phase1 ${row.job_key} failed:`, err.message); markFailed(row, err.message); }
		}));
		// phase 2 singleton
		let claim = claimPhase2();
		if (claim.outcome === "recycled") claim = claimPhase2(); // retry after pending reset
		if (claim.outcome === "claimed") {
			didWork = true;
			try { await runPhase2AsAgent(claim.row); }
			catch (err) { log("phase2 unexpected error:", err.message); markPhase2Failed(claim.row, err.message); }
		} else if (claim.outcome !== "no_job" && claim.outcome !== "skipped_cooldown" && claim.outcome !== "skipped_running" && claim.outcome !== "skipped_retry_backoff") {
			log("phase2 claim:", claim.outcome);
		}
	} catch (err) {
		log("poll error:", err.message);
	} finally {
		polling = false;
	}
	return didWork ? 1 : 0;
}

function coordinatorConfig() {
	const coordinator = cfg?.coordinator;
	if (!coordinator?.leaseKey || !coordinator?.token || !coordinator?.leaseMs) return null;
	return coordinator;
}

function heartbeatCoordinator() {
	const coordinator = coordinatorConfig();
	if (!db || !coordinator || !coordinatorActive) return false;
	try {
		const owned = heartbeatWorkerLease(db, coordinator.leaseKey, coordinator.token, coordinator.leaseMs);
		if (!owned) {
			coordinatorActive = false;
			log("global worker lease lost; stopping");
			setImmediate(() => process.exit(0));
		}
		return owned;
	} catch (error) {
		// A transient SQLite busy error must not surrender ownership prematurely;
		// the next heartbeat retries before the short lease expires.
		log("worker lease heartbeat failed:", error.message);
		return false;
	}
}

function startLoop() {
	const coordinator = coordinatorConfig();
	if (!coordinator) {
		log("missing global worker coordinator config; exiting");
		process.exit(1);
		return;
	}
	coordinatorActive = true;
	if (!heartbeatCoordinator()) return;
	coordinatorTimer = setInterval(heartbeatCoordinator, Math.max(1000, Number(coordinator.heartbeatMs) || 10_000));
	coordinatorTimer.unref?.();
	try { prepareMemoryWorkspace(); } // baseline must exist BEFORE phase-1 writes
	catch (error) { log("memory workspace baseline preparation failed:", error.message); }
	// Codex is event-driven (work is spawned per turn), so a fixed fast poll
	// wastes cycles — especially with the 6h idle gate. Sleep until the next
	// actionable job: after a busy poll poll again soon (work may chain),
	// otherwise sleep to the earliest due time or the fallback interval.
	const schedule = async () => {
		const worked = await pollOnce();
		const delay = worked ? 1000 : nextWakeMs(Date.now());
		setTimeout(() => { void schedule(); }, delay);
	};
	void schedule();
}

let shuttingDown = false;

function releaseOwnLeases() {
	if (!db) return;
	try {
		const now = Date.now();
		const res = db.prepare(
			`UPDATE jobs SET status='pending', worker_id=NULL, ownership_token=NULL, lease_until=NULL, started_at=NULL
			 WHERE status IN ('leased','running') AND worker_id = ? AND lease_until > ?`,
		).run(WORKER_ID, now);
		if (res.changes > 0) debug(`released ${res.changes} stranded job lease(s) owned by ${WORKER_ID}`);
		const coordinator = coordinatorConfig();
		if (coordinator) releaseWorkerLease(db, coordinator.leaseKey, coordinator.token);
		coordinatorActive = false;
		if (coordinatorTimer) clearInterval(coordinatorTimer);
		coordinatorTimer = null;
	} catch {
		/* best-effort on exit */
	}
}

function drainAndExit() {
	if (shuttingDown) return;
	shuttingDown = true;
	debug("shutdown requested; draining pending jobs before exit");
	(async () => {
		for (let i = 0; i < 40; i++) {
			await pollOnce();
			const pending = db.prepare(
				`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','failed') AND (retry_until IS NULL OR retry_until <= ?)`,
			).get(Date.now()).n;
			if (pending === 0) {
				debug("queue drained; exiting");
				process.exit(0);
				return;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		debug("grace period elapsed with pending jobs; exiting");
		process.exit(0);
	})();
}

process.on("exit", () => { releaseOwnLeases(); });
process.on("SIGTERM", () => { releaseOwnLeases(); process.exit(0); });
process.on("SIGINT", () => { releaseOwnLeases(); process.exit(0); });

process.on("message", (msg) => {
	if (!msg) return;
	if (msg.type === "config") {
		cfg = msg.config;
		openDb();
		ensureLayout();
		debug(`configured: db=${cfg.dbPath} model=${cfg.llm?.model} poll=${cfg?.pollMs ?? POLL_MS_DEFAULT}ms`);
		startLoop();
	} else if (msg.type === "shutdown") {
		drainAndExit();
	}
});

process.on("disconnect", () => {
	debug("parent disconnected; draining before exit");
	drainAndExit();
});

setTimeout(() => {
	if (!cfg) { log("no config received within 10s; exiting"); process.exit(1); }
}, 10_000);
