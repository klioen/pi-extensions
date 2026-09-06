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
const { SCHEMA, phase1Prompt, completeLLM, parseJsonObj } = require(path.join(__dirname, "..", "lib", "memory-core.cjs"));

const WORKER_ID = `w-${process.pid}`;
const POLL_MS_DEFAULT = 60_000; // fallback interval when nothing is due (codex: work is triggered, not polled)
const LEASE_MS = 60 * 60 * 1000;        // 1h lease (codex JOB_LEASE_SECONDS=3600); idempotent retry makes it safe
const RETRY_DELAY_MS = 60 * 60 * 1000;  // 1h retry backoff (codex JOB_RETRY_DELAY_SECONDS)
const PHASE2_SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown (codex)
const PHASE2_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;
const MIN_ROLLOUT_IDLE_MS = (Number(process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS) || 6) * 3600 * 1000; // codex default 6h

let cfg = null;
let db = null;
let polling = false;

function log(...args) { console.error(`[pi-memory-worker]`, ...args); }

function openDb() {
	db = new DatabaseSync(cfg.dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(SCHEMA);
	db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

function kvGet(key, fallback = null) {
	const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
	return row ? JSON.parse(row.value) : fallback;
}
function kvSet(key, value) {
	db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
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
       WHERE kind = 'phase1' AND status IN ('pending','failed')
         AND (status = 'pending' OR (retry_until IS NOT NULL AND retry_until <= ?))
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY created_at ASC LIMIT ?`,
	).all(now, now, CONCURRENCY * 4);
	// Drop not-yet-idle jobs (keep them pending for a later poll).
	const rows = allRows.filter((row) => {
		if (!row.input_watermark) return true; // no ts → no idle gate (legacy)
		return row.input_watermark <= idleCutoff;
	});
	// Codex idempotency: skip jobs whose input_watermark is already covered by
	// stage1_outputs.source_updated_at (SkippedUpToDate). A retried or duplicate
	// phase-1 job then marks completed without re-running the LLM.
	const upToDate = rows.filter((row) => {
		if (!row.input_watermark) return false;
		const output = db.prepare(`SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?`).get(row.job_key);
		return output && Number(output.source_updated_at) >= Number(row.input_watermark);
	});
	for (const row of upToDate) {
		// job was never claimed, so no ownership token — update status directly
		db.prepare(`UPDATE jobs SET status='completed', finished_at=? WHERE kind='phase1' AND job_key=?`).run(Date.now(), row.job_key);
		log(`phase1 ${row.job_key}: up-to-date (watermark ${row.input_watermark}), skipping`);
	}
	const eligible = rows.filter((row) => !upToDate.includes(row));
	const stmt = db.prepare(
		`UPDATE jobs SET status='leased', worker_id=?, ownership_token=?, lease_until=? WHERE kind='phase1' AND job_key=? AND status IN ('pending','failed')`,
	);
	const claimed = [];
	for (const row of eligible) {
		const token = `${WORKER_ID}-${row.job_key}-${Date.now()}`;
		if (stmt.run(WORKER_ID, token, now + LEASE_MS, row.job_key).changes > 0) {
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
		const latestSource = db.prepare(`SELECT COALESCE(MAX(source_updated_at), 0) AS m FROM stage1_outputs`).get().m;
		if (lastSuccess <= cooldownCutoff && latestSource > (row.input_watermark ?? 0)) {
			db.prepare(`UPDATE jobs SET status='pending', lease_until=NULL, finished_at=NULL WHERE kind=? AND job_key=?`).run(P2_KIND, P2_KEY);
			return { outcome: "recycled" };
		}
		return { outcome: "skipped_cooldown" };
	}
	return { outcome: "no_job" };
}

function markPhase2Failed(row, errMsg) {
	log("markPhase2Failed row:", JSON.stringify(row));
	db.prepare(
		`UPDATE jobs SET status='failed', last_error=?, retry_until=?, retry_remaining=retry_remaining-1, lease_until=NULL
       WHERE kind=? AND job_key=? AND ownership_token=?`,
	).run(String(errMsg).slice(0, 2000), Date.now() + RETRY_DELAY_MS, P2_KIND, P2_KEY, row.ownership_token);
}

function markPhase2Completed(row) {
	log("markPhase2Completed row:", JSON.stringify(row));
	const now = Date.now();
	db.prepare(
		`UPDATE jobs SET status='completed', finished_at=?, lease_until=NULL WHERE kind=? AND job_key=? AND ownership_token=?`,
	).run(now, P2_KIND, P2_KEY, row.ownership_token);
	kvSet("phase2_last_success_at", now);
	const latestSource = db.prepare(`SELECT COALESCE(MAX(source_updated_at), 0) AS m FROM stage1_outputs`).get().m;
	kvSet(P2_WATERMARK, latestSource);
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

function writePhase1Artifacts(output, cwd, threadId) {
	ensureLayout();
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = (output.rollout_slug?.trim() || "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "rollout";
	const file = path.join(cfg.memDir, "rollout_summaries", `${ts}-${slug}.md`);
	fs.writeFileSync(file, [`# ${slug}`, "", `- thread_id: ${threadId}`, `- updated_at: ${new Date().toISOString()}`, `- cwd: ${cwd}`, "", output.rollout_summary?.trim() ?? "", ""].join("\n"));
	const raw = fs.readFileSync(path.join(cfg.memDir, "raw_memories.md"), "utf8");
	const append = ["", `## Thread \`${threadId}\` (${ts})`, "", `updated_at: ${new Date().toISOString()}`, `cwd: ${cwd}`, `rollout_summary_file: ${path.relative(cfg.memDir, file)}`, "", output.raw_memory?.trim() ?? "", ""].join("\n");
	fs.writeFileSync(path.join(cfg.memDir, "raw_memories.md"), raw.replace(/\s*$/, "\n") + append);
	return path.relative(cfg.memDir, file);
}

async function runPhase1(row) {
	const payload = JSON.parse(row.payload);
	const prompt = phase1Prompt(payload.transcript, payload.rolloutPath, payload.rolloutCwd);
	const raw = await completeLLM(cfg.llm, prompt);
	const parsed = parseJsonObj(raw);
	if (!parsed || (!parsed.raw_memory && !parsed.rollout_summary)) throw new Error("phase1 LLM output unparseable or empty");
	const sourceUpdatedAt = row.input_watermark || Date.now(); // codex: source_updated_at = the input watermark
	db.prepare(
		`INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET source_updated_at=excluded.source_updated_at, raw_memory=excluded.raw_memory,
       rollout_summary=excluded.rollout_summary, rollout_slug=excluded.rollout_slug, cwd=excluded.cwd`,
	).run(payload.threadId, sourceUpdatedAt, parsed.raw_memory, parsed.rollout_summary, parsed.rollout_slug ?? null, payload.rolloutCwd);
	const file = writePhase1Artifacts(parsed, payload.rolloutCwd, payload.threadId);
	log(`phase1 done: ${file}`);
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
	const { execSync } = require("node:child_process");
	return execSync(`git -C "${cfg.memDir}" ${cmd}`, { encoding: "utf8", timeout: 10000 });
}

function prepareMemoryWorkspace() {
	const gitDir = path.join(cfg.memDir, ".git");
	const gitignore = path.join(cfg.memDir, ".gitignore");
	try {
		if (!fs.existsSync(gitignore)) {
			fs.writeFileSync(gitignore, "memory.db\nmemory.db-wal\nmemory.db-shm\n");
		}
		if (!fs.existsSync(gitDir)) {
			git("init -q");
			git('config user.name "pi-memory"');
			git('config user.email "pi-memory@localhost"');
			git("add -A");
			git('commit -qm "baseline"');
			log("memory workspace git baseline initialized");
		}
	} catch (err) {
		log("git baseline init failed:", err.message);
	}
}

function workspaceHasChanges() {
	try {
		if (!fs.existsSync(path.join(cfg.memDir, ".git"))) return true; // no git → assume work exists
		return git("status --porcelain").trim().length > 0;
	} catch {
		return true;
	}
}

function resetMemoryBaseline() {
	try {
		git("add -A");
		git('commit -qm "consolidation baseline"');
		log("memory workspace baseline reset");
	} catch (err) {
		log("git baseline commit failed:", err.message);
	}
}

function phase2AgentPrompt(memDir) {
	return [
		`You are a Memory Writing Agent. Consolidate raw memories and rollout summaries into the local "agent memory" folder at ${memDir}.`,
		``,
		`Read these inputs with the read/grep tools (do not assume their contents):`,
		`- ${memDir}/raw_memories.md   (merged phase-1 outputs; primary input)`,
		`- ${memDir}/MEMORY.md          (existing handbook; update it)`,
		`- ${memDir}/memory_summary.md  (existing summary; first line must stay exactly "v1")`,
		`- ${path.join(memDir, "rollout_summaries")}/  (per-rollout recaps; open when needed)`,
		`- ${path.join(memDir, "skills")}/  (reusable procedures; optional)`,
		``,
		`Then EDIT the files with the edit/write tools:`,
		`1. MEMORY.md — durable handbook. Each block starts with "# Task Group: <cwd/project/workflow>" plus scope: and applies_to: lines; body has "## Task <n>" sections with "### rollout_summary_files" and "### keywords", then block-level "## User preferences" / "## Reusable knowledge" / "## Failures and how to do differently" when meaningful. Preserve original user wording, error strings, commands (grep-ability).`,
		`2. memory_summary.md — must start exactly with "v1". Sections: "## User Profile" (<=350 words), "## User preferences" (actionable bullets), "## General Tips", "## What's in Memory" (routing index with keywords).`,
		`3. Optionally create/update skills/ when there is a clearly reusable procedure.`,
		``,
		`Rules (STRICT): evidence-based only; redact secrets ([REDACTED_SECRET]); do not copy large tool outputs verbatim; if there is no meaningful new signal, make minimal or no changes; keep files dense and navigation-friendly.`,
		``,
		`Do not modify raw_memories.md or rollout_summaries/. When done, stop.`,
	].join("\n");
}

async function runPhase2AsAgent(row) {
	// Codex-aligned pre-check: the git workspace is the source of truth for
	// whether consolidation has work. When the workspace is clean (phase-1
	// inputs already consolidated and baseline committed), skip the LLM.
	if (!workspaceHasChanges()) {
		log("phase2: no workspace changes since last consolidation; skipping LLM");
		markPhase2Completed(row);
		return;
	}

	// Model selection for the consolidation agent: prefer explicit env, else derived from worker llm config
	const modelSpec = cfg.llm.phase2Model || cfg.llm.model;
	const prompt = phase2AgentPrompt(cfg.memDir);

	const env = {
		...process.env,
		PI_MEMORY_DIR: cfg.memDir,
		PI_MEMORY_AUTO: "0",        // child must not enqueue new jobs (no loops)
		PI_MEMORY_RECALL: "0",      // no recall injection in the child
		PI_MEMORY_AGENT_CHILD: "1", // child must not fork its own worker (no chain)
	};
	const args = ["--print"];
	if (modelSpec) args.push("--model", modelSpec);
	args.push(prompt);

	log(`phase2: spawning pi agent (model=${modelSpec})`);
	const child = spawn("pi", args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	const result = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill("SIGKILL");
				resolve({ ok: false, error: "phase2 agent timed out" });
			}
		}, PHASE2_AGENT_TIMEOUT_MS);
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("error", (err) => {
			if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: String(err) }); }
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const memoryChanged = fs.existsSync(path.join(cfg.memDir, "MEMORY.md")) && fs.existsSync(path.join(cfg.memDir, "memory_summary.md"));
			if (code === 0 && memoryChanged) resolve({ ok: true, stdout: stdout.slice(-2000) });
			else resolve({ ok: false, error: `pi exited ${code}: ${stderr.slice(-500) || stdout.slice(-500)}` });
		});
	});

	if (result.ok) {
		log("phase2: consolidation agent finished");
		resetMemoryBaseline(); // codex: reset_memory_workspace_baseline
		markPhase2Completed(row);
	} else {
		log("phase2 agent failed:", result.error);
		markPhase2Failed(row, result.error);
	}
}

// ---- main loop ----

function nextWakeMs(now) {
	// Earliest moment any queued job becomes actionable:
	// - phase1: input_watermark + idle window (extract once the conversation is idle)
	// - phase2: retry_until backoff, or cooldown expiry
	// - fallback: default poll interval
	const idleMs = MIN_ROLLOUT_IDLE_MS;
	let earliest = now + POLL_MS_DEFAULT;
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
	if (!db || polling) return 0;
	polling = true;
	let didWork = false;
	try {
		// phase 1 jobs
		const phase1 = claimPhase1Jobs();
		if (phase1.length > 0) didWork = true;
		for (const row of phase1) {
			try { await runPhase1(row); markCompleted(row); }
			catch (err) { log(`phase1 ${row.job_key} failed:`, err.message); markFailed(row, err.message); }
		}
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

function startLoop() {
	prepareMemoryWorkspace(); // baseline must exist BEFORE phase-1 writes (codex: prepare_memory_workspace at startup)
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

process.on("message", (msg) => {
	if (!msg) return;
	if (msg.type === "config") {
		cfg = msg.config;
		openDb();
		ensureLayout();
		log(`configured: db=${cfg.dbPath} model=${cfg.llm?.model} poll=${cfg?.pollMs ?? POLL_MS_DEFAULT}ms`);
		startLoop();
	} else if (msg.type === "shutdown") {
		drainAndExit();
	}
});

process.on("disconnect", () => {
	log("parent disconnected; draining before exit");
	drainAndExit();
});

setTimeout(() => {
	if (!cfg) { log("no config received within 10s; exiting"); process.exit(1); }
}, 10_000);
