/**
 * pi-memory: local markdown-file memory for pi, modeled after Codex's memory
 * system (codex-rs/memories/write + ext/memories), with a SQLite job queue
 * consumed by a detached worker process — exactly like Codex's phase-1
 * background task.
 *
 * Storage layout (under ~/.pi/agent/memories or PI_MEMORY_DIR):
 *   memory_summary.md      always loaded into the system prompt; first line "v1"
 *   MEMORY.md              durable handbook; task-grouped blocks, grep-able
 *   raw_memories.md        merged phase-1 outputs (phase-2 input)
 *   rollout_summaries/     per-conversation distilled recaps
 *   skills/                optional reusable procedures (SKILL.md packages)
 *   memory.db              SQLite job queue (jobs + stage1_outputs tables)
 *
 * Pipeline:
 *   Phase 1 (per agent_settled): the extension only enqueues a 'phase1' job
 *     into SQLite and returns immediately — zero blocking. A detached worker
 *     child process (worker/worker.js) polls the queue, claims a lease, calls
 *     the LLM via plain fetch (independent of the pi runtime), writes
 *     stage1_outputs + rollout_summaries/ + raw_memories.md.
 *   Phase 2 (Codex-aligned): after each phase-1 success the worker advances a
 *     global 'memory_consolidate_global' singleton job watermark; the worker
 *     claims it only when the 6h success cooldown / 1h retry backoff allow,
 *     pre-checks for new inputs, and runs a full consolidation AGENT (a forked
 *     `pi --print` child with read/grep/edit/write tools) that rewrites
 *     MEMORY.md and memory_summary.md in place.
 *   Recall (every before_agent_start): memory_summary.md is injected into the
 *     system prompt with a decision boundary, like Codex's read_path.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import memoryCore from "../lib/memory-core.cjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEMORY_DIR = (process.env.PI_MEMORY_DIR || path.join(os.homedir(), ".pi", "agent", "memories")).replace(/\/+$/, "");
const DB_PATH = process.env.PI_MEMORY_DB || path.join(os.homedir(), ".pi", "agent", "sqlite", "memory.db");
const RECALL_ENABLED = process.env.PI_MEMORY_RECALL !== "0";
const AUTO_ENQUEUE = process.env.PI_MEMORY_AUTO !== "0";
const SUMMARY_TOKEN_LIMIT = Math.max(500, Number(process.env.PI_MEMORY_SUMMARY_TOKENS) || 4000);
const ROLLOUT_CHAR_LIMIT = Math.max(4000, Number(process.env.PI_MEMORY_ROLLOUT_CHARS) || 20000);
const EXTRACT_MODEL = process.env.PI_MEMORY_EXTRACT_MODEL || ""; // optional override, like codex extract_model
const MIN_ROLLOUT_IDLE_HOURS = process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS === undefined ? 6 : Math.max(0, Number(process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS)); // codex default 6h; explicit 0 disables
const MAX_ROLLOUT_AGE_DAYS = Math.max(1, Number(process.env.PI_MEMORY_MAX_ROLLOUT_AGE_DAYS) || 10); // codex default = 10
const SCAN_LIMIT = Math.max(1, Number(process.env.PI_MEMORY_SCAN_LIMIT) || 5000); // codex THREAD_SCAN_LIMIT
const MAX_ROLLOUTS_PER_STARTUP = Math.max(1, Number(process.env.PI_MEMORY_MAX_ROLLOUTS_PER_STARTUP) || 2); // codex default = 2
const WORKER_POLL_MS = Math.max(500, Number(process.env.PI_MEMORY_WORKER_POLL_MS) || 3000);
const WORKER_LOG_PATH = process.env.PI_MEMORY_WORKER_LOG || path.join(MEMORY_DIR, "worker.log");
const WORKER_TUI_LOGS = process.env.PI_MEMORY_WORKER_TUI_LOGS === "1";

// DB state keys
const DB_STATE_KEY = "pi-memory-state";
const DB_JOB_KEY = "pi-memory-jobs";

// ---------------------------------------------------------------------------
// DB helpers (main process side: enqueue + state)
// ---------------------------------------------------------------------------

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
	if (!db) {
		fs.mkdirSync(MEMORY_DIR, { recursive: true });
		fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
		db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA journal_mode=WAL;");
		db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    payload TEXT NOT NULL,
    lease_until INTEGER,
    retry_until INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    started_at INTEGER,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);
CREATE TABLE IF NOT EXISTS stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    generated_at INTEGER,
    rollout_slug TEXT,
    cwd TEXT,
    git_branch TEXT,
    usage_count INTEGER,
    last_usage INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_lease ON jobs(status, lease_until);
`);
		// Safe forward migration for databases created before generated_at.
		try { db.exec("ALTER TABLE stage1_outputs ADD COLUMN generated_at INTEGER"); } catch { /* already migrated */ }
	}
	return db;
}

function enqueueJob(kind: string, jobKey: string, payload: unknown): void {
	enqueueJobWithWatermark(kind, jobKey, 0, payload);
}

function enqueueJobWithWatermark(kind: string, jobKey: string, inputWatermark: number, payload: unknown): boolean {
	const d = getDb();
	// Never replace a leased phase-1 job: doing so discards its ownership token
	// and lets duplicate scans run the same rollout twice. This mirrors Codex's
	// stage1_source_needs_update + atomic try_claim_stage1_job sequence.
	if (kind === "phase1") {
		return memoryCore.upsertPhase1Job(d, jobKey, inputWatermark, payload);
	}
	d.prepare(
		`INSERT OR REPLACE INTO jobs (kind, job_key, status, retry_remaining, payload, input_watermark, created_at)
     VALUES (?, ?, 'pending', 3, ?, ?, ?)`,
	).run(kind, jobKey, JSON.stringify(payload), inputWatermark, Date.now());
	return true;
}

function upsertState(key: string, value: unknown): void {
	const d = getDb();
	d.prepare(
		`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	).run();
	d.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

function readState<T>(key: string, fallback: T): T {
	try {
		const d = getDb();
		d.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const row = d.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value?: string } | undefined;
		return row?.value ? (JSON.parse(row.value) as T) : fallback;
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// Session transcript access
// ---------------------------------------------------------------------------

interface SyncMsg {
	entryId: string;
	ts: number; // entry timestamp (ms), used as the phase-1 input watermark
	role: "user" | "assistant";
	content: string;
}

function collectMessages(sm: { getEntries: () => unknown[]; getLeafId: () => string | null }): SyncMsg[] {
	const entries = buildContextEntries(sm.getEntries() as never, sm.getLeafId());
	const out: SyncMsg[] = [];
	for (const entry of entries) {
		if ((entry as { type?: string }).type !== "message") continue;
		const message = (entry as { message?: AgentMessage }).message;
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const content = message.content as unknown;
		const parts = (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) as Array<{ type: string; text?: string }>;
		const text = parts
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join(" ")
			.trim();
		if (!text) continue;
		const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		out.push({ entryId: entry.id, ts: Number.isFinite(ts) ? ts : 0, role: message.role, content: text });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Idle-session scan (codex claim_stage1_jobs_for_startup)
//
// Codex never checks whether the CURRENT thread is idle — on every new turn
// it SQL-scans the threads table for OTHER threads whose updated_at is at
// least min_rollout_idle_hours ago and enqueues phase-1 extraction for them.
// pi analog: scan the sessions directory for other session files whose last
// message is at least MIN_ROLLOUT_IDLE_HOURS old. Watermark idempotency
// (stage1_outputs.source_updated_at >= input_watermark) is enforced by the
// worker, so re-scans are harmless.
// ---------------------------------------------------------------------------

function sessionsRoot(): string {
	return process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * Read the tail of a session file to obtain only the timestamp of its last
 * user/assistant message. The worker loads the full stable rollout after it
 * claims the job; this scan stays cheap (at most 512KB per candidate).
 */
function readSessionTail(file: string): { lastTs: number } | null {
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return null;
	}
	if (size === 0) return null;
	const tailBytes = Math.min(size, 512 * 1024);
	const buf = Buffer.alloc(tailBytes);
	try {
		const fd = fs.openSync(file, "r");
		fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
		fs.closeSync(fd);
	} catch {
		return null;
	}
	let lastTs = 0;
	for (const line of buf.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let d: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
		try {
			d = JSON.parse(line);
		} catch {
			continue; // possibly a truncated first line at the tail boundary
		}
		if (d.type !== "message" || !d.message) continue;
		const msg = d.message;
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "toolResult") continue;
		const content = msg.content;
		const textParts = (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) as Array<{ type: string; text?: string }>;
		const text = textParts
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join(" ")
			.trim();
		// An assistant tool call is activity too, even though its content has no
		// text until the paired toolResult arrives.
		const hasToolCall = msg.role === "assistant" && textParts.some((p) => p.type === "toolCall");
		if (!text && !hasToolCall) continue;
		const ts = Date.parse(String(d.timestamp ?? ""));
		if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
	}
	if (lastTs <= 0) return null;
	return { lastTs };
}

/** Scan the sessions directory for other, idle-enough sessions (codex idle scan). */
function findIdleSessions(
	currentFile: string | undefined,
	minIdleMs: number,
	maxAgeMs: number,
	limit: number,
): Array<{ file: string; lastTs: number }> {
	const root = sessionsRoot();
	const out: Array<{ file: string; lastTs: number }> = [];
	const fileCandidates: Array<{ file: string; mtimeMs: number }> = [];
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const dir of dirs) {
		const dirPath = path.join(root, dir);
		let st: fs.Stats;
		try {
			st = fs.statSync(dirPath);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		let files: string[] = [];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const full = path.join(dirPath, f);
			if (currentFile && full === currentFile) continue; // exclude the active session
			try {
				fileCandidates.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
			} catch { /* file disappeared during scan */ }
		}
	}
	// Approximate Codex's indexed ORDER BY updated_at before parsing JSONL tails.
	for (const candidate of fileCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)) {
		const tail = readSessionTail(candidate.file);
		if (!tail) continue;
		const idleMs = Date.now() - tail.lastTs;
		if (idleMs >= minIdleMs && idleMs <= maxAgeMs) out.push({ file: candidate.file, lastTs: tail.lastTs });
	}
	return out.sort((a, b) => b.lastTs - a.lastTs);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker: ChildProcess | null = null;
let workerConfig: Record<string, unknown> | null = null;

function resolveExtractModel(ctxModel: unknown): { baseUrl: string; model: string; phase2Model: string; apiKey: string; maxTokens?: number } {
	const m = ctxModel as { baseUrl?: string; id?: string; provider?: string } | undefined;
	// baseUrl: explicit override, else the current model's baseUrl. When that is
	// unavailable fall back to the ark OpenAI-compatible endpoint (the default pi
	// provider) rather than ollama.
	const baseUrl = process.env.PI_MEMORY_BASE_URL || m?.baseUrl || "https://ark.cn-beijing.volces.com/api/coding/v3";
	// extract model: explicit override, else the current model id.
	const model = EXTRACT_MODEL || process.env.PI_MEMORY_EXTRACT_MODEL || m?.id || "";
	// phase-2 consolidation AGENT model: explicit, else same as extract model.
	// `pi --print --model <provider>/<id>` expects the provider-prefixed form.
	const phase2Model = process.env.PI_MEMORY_PHASE2_MODEL || (m?.provider ? `${m.provider}/${model}` : model);
	const keys = (process.env.ARK_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
	const apiKey = keys[0] || process.env.ARK_API_KEY || (m?.provider ? process.env[`${m.provider.toUpperCase()}_API_KEY`] : "") || "placeholder";
	const maxTokens = Number(process.env.PI_MEMORY_EXTRACT_MAX_TOKENS) || 2048;
	return { baseUrl, model, phase2Model, apiKey, maxTokens };
}

function startWorker(ctxModel: unknown): void {
	if (worker) return;
	const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "worker.cjs");
	workerConfig = {
		dbPath: DB_PATH,
		memDir: MEMORY_DIR,
		pollMs: WORKER_POLL_MS,
		rolloutCharLimit: ROLLOUT_CHAR_LIMIT,
		llm: resolveExtractModel(ctxModel),
	};
	// Never inherit worker stderr into the TUI: repeated phase1 failures can
	// consume the footer and shrink the input editor. Persist diagnostics to a
	// local log; opt into live TUI output only for debugging.
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	worker = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
	worker.stderr?.on("data", (chunk: Buffer) => {
		try { fs.appendFileSync(WORKER_LOG_PATH, chunk); } catch { /* best-effort */ }
		if (WORKER_TUI_LOGS) process.stderr.write(chunk);
	});
	worker.send({ type: "config", config: workerConfig });
	worker.on("exit", () => {
		worker = null;
	});
}

function stopWorker(): void {
	if (worker) {
		try {
			worker.send({ type: "shutdown" });
			worker = null;
		} catch {
			worker?.kill();
			worker = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Recall: inject memory_summary.md into the system prompt
// ---------------------------------------------------------------------------

function ensureLayout(): void {
	for (const p of [MEMORY_DIR, path.join(MEMORY_DIR, "rollout_summaries"), path.join(MEMORY_DIR, "skills")]) {
		fs.mkdirSync(p, { recursive: true });
	}
	if (!fs.existsSync(path.join(MEMORY_DIR, "memory_summary.md"))) {
		fs.writeFileSync(path.join(MEMORY_DIR, "memory_summary.md"), "v1\n\n## User Profile\n\n(empty)\n");
	}
	if (!fs.existsSync(path.join(MEMORY_DIR, "MEMORY.md"))) {
		fs.writeFileSync(path.join(MEMORY_DIR, "MEMORY.md"), "# MEMORY\n\n(empty)\n");
	}
	if (!fs.existsSync(path.join(MEMORY_DIR, "raw_memories.md"))) {
		fs.writeFileSync(path.join(MEMORY_DIR, "raw_memories.md"), "# Raw Memories\n\n");
	}
}

function recordRolloutSummaryUsage(readPath: unknown): void {
	if (typeof readPath !== "string") return;
	const summariesDir = path.join(MEMORY_DIR, "rollout_summaries") + path.sep;
	const resolved = path.resolve(readPath);
	if (!resolved.startsWith(summariesDir) || !resolved.endsWith(".md")) return;
	// Materialized filenames end in the first 8 chars of thread_id. UUID-prefix
	// collisions are negligible; update only that cited rollout output.
	const m = path.basename(resolved, ".md").match(/-([0-9a-f]{8})$/i);
	if (!m) return;
	const now = Date.now();
	getDb().prepare(
		`UPDATE stage1_outputs
		 SET usage_count=COALESCE(usage_count, 0)+1, last_usage=?
		 WHERE substr(thread_id, 1, 8)=?`,
	).run(now, m[1]);
}

function buildRecallBlock(): string {
	ensureLayout();
	try {
		const summary = fs.readFileSync(path.join(MEMORY_DIR, "memory_summary.md"), "utf8").trim();
		if (!summary || summary === "v1\n\n## User Profile\n\n(empty)") return "";
		const truncated = summary.slice(0, SUMMARY_TOKEN_LIMIT * 4);
		return [
			`## Memory`,
			``,
			`You have access to a memory folder with guidance from prior runs. Use it whenever it is likely to help.`,
			``,
			`Decision boundary: skip memory ONLY when the request is clearly self-contained (current date, simple translation, one-line command). Otherwise use memory by default when the task involves workspace history, conventions, prior decisions, the user's preferences, or could depend on earlier project choices.`,
			``,
			`Memory layout (general -> specific):`,
			`- ${path.join(MEMORY_DIR, "memory_summary.md")} (provided below; do NOT open again)`,
			`- ${path.join(MEMORY_DIR, "MEMORY.md")} (searchable registry; primary file to query)`,
			`- ${path.join(MEMORY_DIR, "skills")}/<skill-name>/SKILL.md (reusable procedures)`,
			`- ${path.join(MEMORY_DIR, "rollout_summaries")}/ (per-rollout recaps)`,
			``,
			`Quick pass: skim the summary below, extract relevant keywords, then search MEMORY.md using those keywords, and open 1-2 relevant rollout summaries or skills if pointed to. Keep lookup lightweight (<= 4-6 steps).`,
			``,
			`memory_summary.md:`,
			truncated,
			``,
			`If you rely on memory for facts you did not verify in this turn, say so briefly and note the answer may be stale.`,
		].join("\n");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	ensureLayout();
	getDb();

	if (RECALL_ENABLED) {
		pi.on("before_agent_start", async () => {
			try {
				const block = buildRecallBlock();
				if (!block) return;
				return {
					message: {
						customType: "pi-memory-recall",
						content: block,
						display: false,
					},
				};
			} catch {
				return undefined;
			}
		});
	}

	// Codex records usage when a model cites a specific stage-1 memory. pi has
	// no native citation item, so a read of a materialized rollout summary is
	// the deterministic equivalent and drives retention/phase2 selection.
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "read") recordRolloutSummaryUsage(event.args?.path);
	});

	pi.on("session_start", async (_event, ctx) => {
		// When running as a phase-2 consolidation agent (forked by the worker),
		// never fork another worker — the child only edits the memory workspace.
		if (process.env.PI_MEMORY_AGENT_CHILD === "1") return;
		startWorker(ctx.model);
	});

	pi.on("session_shutdown", async () => {
		stopWorker();
	});

	if (AUTO_ENQUEUE) {
		pi.on("agent_settled", async (_event, ctx) => {
			try {
				const sm = ctx.sessionManager;
				const currentFile = sm.getSessionFile?.();
				const minIdleMs = MIN_ROLLOUT_IDLE_HOURS * 3600_000;
				const maxAgeMs = MAX_ROLLOUT_AGE_DAYS * 24 * 3600_000;
				// Codex claim_stage1_jobs_for_startup: scan OTHER sessions whose last
				// activity is at least min_rollout_idle_hours ago and enqueue phase-1
				// for them. The active session is excluded (it is the current one).
				const candidates = findIdleSessions(currentFile, minIdleMs, maxAgeMs, SCAN_LIMIT);
				let enqueued = 0;
				// Like Codex max_rollouts_per_startup, bound actual new claims even
				// when the historical scan sees thousands of candidate sessions.
				// Skip already-completed/leased candidates without wasting a slot.
				for (const c of candidates) {
					if (enqueued >= MAX_ROLLOUTS_PER_STARTUP) break;
					const tail = readSessionTail(c.file);
					if (!tail) continue;
					const threadId = path.basename(c.file).replace(/\.jsonl$/, "");
					const inserted = enqueueJobWithWatermark("phase1", threadId, tail.lastTs, {
						// Worker reloads the full stable session at execution time, just
						// like Codex loads rollout items after claiming the job.
						rolloutPath: c.file,
						threadId,
					});
					if (inserted) enqueued++;
				}
				if (enqueued > 0 && !worker) startWorker(ctx.model);
			} catch {
				/* never break the session */
			}
		});
	}

	pi.registerCommand("memory", {
		description: "pi-memory: /memory (status) | consolidate | path | log [lines] | reset",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];
			if (sub === "log") {
				// Read only the tail: worker.log is append-only and may grow large.
				// Deliberately bounded so an explicit diagnostic view cannot consume the
				// whole TUI footer that the worker's live stderr used to consume.
				const requested = Number(parts[1]);
				const lines = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 20;
				try {
					const stat = fs.statSync(WORKER_LOG_PATH);
					const start = Math.max(0, stat.size - 32 * 1024);
					const fd = fs.openSync(WORKER_LOG_PATH, "r");
					const data = Buffer.alloc(stat.size - start);
					fs.readSync(fd, data, 0, data.length, start);
					fs.closeSync(fd);
					const tail = data.toString("utf8").trim().split(/\r?\n/).slice(-lines).join("\n");
					ctx.ui.notify(tail ? `pi-memory worker log (last ${lines} lines):\n${tail}` : "pi-memory: worker log is empty.", "info");
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					ctx.ui.notify(code === "ENOENT" ? "pi-memory: no worker log yet." : `pi-memory: could not read worker log: ${String(error)}`, "warning");
				}
				return;
			}
			if (sub === "path") {
				ctx.ui.notify(`Memory dir: ${MEMORY_DIR}\nDB: ${DB_PATH}\nWorker log: ${WORKER_LOG_PATH}`, "info");
				return;
			}
			if (sub === "consolidate") {
				enqueueJob("memory_consolidate_global", "consolidation", { reason: "manual", force: true });
				ctx.ui.notify("pi-memory: phase2 consolidation job enqueued (worker will pick it up).", "info");
				return;
			}
			if (sub === "reset") {
				stopWorker();
				try {
					if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
				} catch {
					/* ignore */
				}
				ctx.ui.notify("pi-memory: memory.db removed; worker stopped. Memory markdown files kept.", "info");
				return;
			}
			ensureLayout();
			const rolloutFiles = fs.readdirSync(path.join(MEMORY_DIR, "rollout_summaries")).filter((f) => f.endsWith(".md"));
			const skills = fs.existsSync(path.join(MEMORY_DIR, "skills"))
				? fs.readdirSync(path.join(MEMORY_DIR, "skills")).filter((f) => fs.statSync(path.join(MEMORY_DIR, "skills", f)).isDirectory())
				: [];
			const rawSize = fs.statSync(path.join(MEMORY_DIR, "raw_memories.md")).size;
			const jobs = (() => {
				try {
					return getDb().prepare(`SELECT kind, status, count(*) as n FROM jobs GROUP BY kind, status`).all() as Array<{ kind: string; status: string; n: number }>;
				} catch {
					return [];
				}
			})();
			ctx.ui.notify(
				[
					`pi-memory`,
					`dir: ${MEMORY_DIR}`,
					`worker: ${worker ? `running (pid ${worker.pid})` : "stopped"}`,
					`worker_log: ${WORKER_LOG_PATH}`,
					`rollout_summaries: ${rolloutFiles.length}`,
					`skills: ${skills.length}`,
					`raw_memories.md: ${rawSize} bytes`,
					`jobs: ${jobs.map((j) => `${j.kind}/${j.status}=${j.n}`).join(", ") || "(none)"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
