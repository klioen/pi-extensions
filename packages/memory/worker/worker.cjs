#!/usr/bin/env node
/**
 * pi-memory worker — independent child process that polls the memory SQLite
 * job queue and executes phase-1 / phase-2 LLM distillation jobs.
 *
 * Runs detached from the pi process (child_process.fork), so it survives pi
 * exiting in print/CI mode. Config arrives via IPC message from the parent
 * ({ dbPath, memDir, llm, pollMs }). The LLM call uses plain fetch against an
 * OpenAI-compatible endpoint, so this worker has no dependency on the pi
 * runtime or jiti.
 */
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { SCHEMA, phase1Prompt, phase2Prompt, completeLLM, parseJsonObj } = require(path.join(__dirname, "..", "lib", "memory-core.cjs"));

const WORKER_ID = `w-${process.pid}`;
const POLL_MS_DEFAULT = 3000;
const LEASE_MS = 5 * 60 * 1000; // a job must finish within 5 min of lease
const RETRY_DELAY_MS = 60 * 1000;
const CONCURRENCY = 4;

let cfg = null;
let db = null;
let running = true;
let polling = false;

function log(...args) {
	console.error(`[pi-memory-worker]`, ...args);
}

function openDb() {
	db = new DatabaseSync(cfg.dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(SCHEMA);
}

// ---- job claim / result helpers (mirror codex claim_stage1_jobs) ----

function claimJobs(kind) {
	const now = Date.now();
	const rows = db
		.prepare(
			`SELECT * FROM jobs
       WHERE kind = ? AND status IN ('pending','failed')
         AND (status = 'pending' OR (retry_until IS NOT NULL AND retry_until <= ?))
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY created_at ASC LIMIT ?`,
		)
		.all(kind, now, now, CONCURRENCY);
	if (rows.length === 0) return rows;
	const stmt = db.prepare(
		`UPDATE jobs SET status='leased', worker_id=?, ownership_token=?, lease_until=? WHERE kind=? AND job_key=? AND status IN ('pending','failed')`,
	);
	for (const row of rows) {
		const token = `${WORKER_ID}-${row.job_key}-${Date.now()}`;
		const upd = stmt.run(WORKER_ID, token, now + LEASE_MS, kind, row.job_key);
		if (upd.changes === 0) {
			// lost race; skip
			row._lost = true;
			continue;
		}
		row.ownership_token = token;
	}
	return rows.filter((r) => !r._lost);
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

// ---- artifact writes (same layout as before) ----

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
	fs.writeFileSync(
		file,
		[
			`# ${slug}`,
			``,
			`- thread_id: ${threadId}`,
			`- updated_at: ${new Date().toISOString()}`,
			`- cwd: ${cwd}`,
			``,
			output.rollout_summary?.trim() ?? "",
			``,
		].join("\n"),
	);
	const raw = fs.readFileSync(path.join(cfg.memDir, "raw_memories.md"), "utf8");
	const append = [
		``,
		`## Thread \`${threadId}\` (${ts})`,
		``,
		`updated_at: ${new Date().toISOString()}`,
		`cwd: ${cwd}`,
		`rollout_summary_file: ${path.relative(cfg.memDir, file)}`,
		``,
		output.raw_memory?.trim() ?? "",
		``,
	].join("\n");
	fs.writeFileSync(path.join(cfg.memDir, "raw_memories.md"), raw.replace(/\s*$/, "\n") + append);
	return path.relative(cfg.memDir, file);
}

function readFile(name) {
	const p = path.join(cfg.memDir, name);
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function computeDiff() {
	try {
		const gitDir = path.join(cfg.memDir, ".git");
		if (fs.existsSync(gitDir)) {
			const { execSync } = require("node:child_process");
			const out = execSync(`git -C "${cfg.memDir}" status --short && echo ---- && git -C "${cfg.memDir}" diff --stat`, {
				encoding: "utf8",
				timeout: 5000,
			});
			return out.trim() || "(no changes)";
		}
	} catch {
		/* fall through */
	}
	return "(no workspace diff available)";
}

function writeSummaryEnsuringV1(summary) {
	let s = summary.trim();
	if (!s.startsWith("v1")) s = "v1\n\n" + s.replace(/^## /, "## ");
	fs.writeFileSync(path.join(cfg.memDir, "memory_summary.md"), s + "\n");
}

// ---- job executors ----

async function runPhase1(row) {
	const payload = JSON.parse(row.payload);
	const { transcript, rolloutPath, rolloutCwd, threadId } = payload;
	const prompt = phase1Prompt(transcript, rolloutPath, rolloutCwd);
	const raw = await completeLLM(cfg.llm, prompt);
	const parsed = parseJsonObj(raw);
	if (!parsed || (!parsed.raw_memory && !parsed.rollout_summary)) {
		throw new Error("phase1 LLM output unparseable or empty");
	}
	// persist to stage1_outputs + artifacts
	db.prepare(
		`INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       source_updated_at=excluded.source_updated_at,
       raw_memory=excluded.raw_memory,
       rollout_summary=excluded.rollout_summary,
       rollout_slug=excluded.rollout_slug,
       cwd=excluded.cwd`,
	).run(threadId, Date.now(), parsed.raw_memory, parsed.rollout_summary, parsed.rollout_slug ?? null, rolloutCwd);
	const file = writePhase1Artifacts(parsed, rolloutCwd, threadId);
	log(`phase1 done: ${file}`);
}

async function runPhase2(row) {
	const payload = JSON.parse(row.payload);
	const existingMemory = readFile("MEMORY.md").slice(0, 30000);
	const existingSummary = readFile("memory_summary.md").slice(0, 16000);
	const newRaw = readFile("raw_memories.md").slice(0, 20000);
	const diffText = computeDiff();
	const prompt = phase2Prompt(existingMemory, existingSummary, newRaw, diffText);
	const raw = await completeLLM(cfg.llm, prompt);
	const parsed = parseJsonObj(raw);
	if (!parsed || (!parsed.memory_md && !parsed.summary_md)) {
		throw new Error("phase2 LLM output unparseable or empty");
	}
	if (parsed.memory_md?.trim()) fs.writeFileSync(path.join(cfg.memDir, "MEMORY.md"), parsed.memory_md.trim() + "\n");
	if (parsed.summary_md?.trim()) writeSummaryEnsuringV1(parsed.summary_md);
	log("phase2 consolidated MEMORY.md + memory_summary.md");
}

async function executeJob(row) {
	try {
		if (row.kind === "phase1") await runPhase1(row);
		else if (row.kind === "phase2") await runPhase2(row);
		else throw new Error(`unknown job kind: ${row.kind}`);
		markCompleted(row);
	} catch (err) {
		log(`job ${row.kind}/${row.job_key} failed:`, err.message);
		markFailed(row, err.message);
	}
}

// ---- main loop ----

async function pollOnce() {
	if (!db || polling) return;
	polling = true;
	try {
		// phase1 first (usually enqueued more often), then phase2
		for (const kind of ["phase1", "phase2"]) {
			const jobs = claimJobs(kind);
			for (const row of jobs) {
				// run sequentially for simplicity; concurrency via forking more workers
				await executeJob(row);
			}
		}
	} catch (err) {
		log("poll error:", err.message);
	} finally {
		polling = false;
	}
}

function startLoop() {
	const ms = cfg?.pollMs ?? POLL_MS_DEFAULT;
	setInterval(() => {
		void pollOnce();
	}, ms);
	// immediate first poll
	void pollOnce();
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
		running = false;
		log("shutting down");
		process.exit(0);
	}
});

// parent died without IPC shutdown: exit too
process.on("disconnect", () => {
	if (running) {
		log("parent disconnected; exiting");
		process.exit(0);
	}
});

setTimeout(() => {
	if (!cfg) {
		log("no config received within 10s; exiting");
		process.exit(1);
	}
}, 10_000);
