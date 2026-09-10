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
 *   Phase 1 (per agent_settled): the extension only upserts the current pi
 *     session into SQLite and requests a scan. The global leader queries the
 *     indexed sessions table, creates bounded phase1 jobs, claims leases, calls
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
import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import memoryCore from "../lib/memory-core.cjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEMORY_DIR = (process.env.PI_MEMORY_DIR || path.join(os.homedir(), ".pi", "agent", "memories")).replace(/\/+$/, "");
const DB_PATH = process.env.PI_MEMORY_DB || path.join(os.homedir(), ".pi", "agent", "sqlite", "memory.db");
const RECALL_ENABLED = process.env.PI_MEMORY_RECALL !== "0";
const AUTO_ENQUEUE = process.env.PI_MEMORY_AUTO !== "0";
const SUMMARY_TOKEN_LIMIT = Math.max(500, Number(process.env.PI_MEMORY_SUMMARY_TOKENS) || memoryCore.MEMORY_RECALL_SUMMARY_TOKEN_LIMIT);
const DEFAULT_MEMORY_MODEL = "traex/DeepSeek-V4-Flash";
const DEFAULT_MEMORY_CONTEXT_WINDOW = 184_000;
const EXTRACT_MODEL = process.env.PI_MEMORY_EXTRACT_MODEL || DEFAULT_MEMORY_MODEL; // optional override, like codex extract_model
const MIN_ROLLOUT_IDLE_HOURS = process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS === undefined ? 6 : Math.max(0, Number(process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS)); // forwarded to the global worker
const MAX_ROLLOUT_AGE_DAYS = Math.max(1, Number(process.env.PI_MEMORY_MAX_ROLLOUT_AGE_DAYS) || 10); // forwarded to the global worker
const SCAN_LIMIT = Math.max(1, Number(process.env.PI_MEMORY_SCAN_LIMIT) || 5000); // forwarded to the global worker
const MAX_ROLLOUTS_PER_STARTUP = Math.max(1, Number(process.env.PI_MEMORY_MAX_ROLLOUTS_PER_STARTUP) || 2); // forwarded to the global worker
const WORKER_POLL_MS = Math.max(500, Number(process.env.PI_MEMORY_WORKER_POLL_MS) || 3000);
const WORKER_LOG_PATH = process.env.PI_MEMORY_WORKER_LOG || path.join(MEMORY_DIR, "worker.log");
const WORKER_TUI_LOGS = process.env.PI_MEMORY_WORKER_TUI_LOGS === "1";
const WORKER_LEASE_KEY = "global-worker";
const WORKER_LEASE_MS = Math.max(10_000, Number(process.env.PI_MEMORY_WORKER_LEASE_MS) || 30_000);
const WORKER_HEARTBEAT_MS = Math.max(1_000, Math.min(WORKER_LEASE_MS / 2, Number(process.env.PI_MEMORY_WORKER_HEARTBEAT_MS) || 10_000));

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
		db.exec("PRAGMA busy_timeout=5000;");
		db.exec("PRAGMA journal_mode=WAL;");
		db.exec(memoryCore.SCHEMA);
		// Safe forward migrations for databases created by earlier pi-memory builds.
		for (const sql of [
			"ALTER TABLE stage1_outputs ADD COLUMN generated_at INTEGER",
			"ALTER TABLE stage1_outputs ADD COLUMN rollout_path TEXT",
			"ALTER TABLE stage1_outputs ADD COLUMN selected_for_phase2 INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE stage1_outputs ADD COLUMN selected_for_phase2_source_updated_at INTEGER",
		]) {
			try { db.exec(sql); } catch { /* already migrated */ }
		}
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
// Session index
// ---------------------------------------------------------------------------

function indexCurrentSession(ctx: { cwd: string; sessionManager: { getSessionFile(): string | undefined; getSessionId(): string } }): boolean {
	const rolloutPath = ctx.sessionManager.getSessionFile();
	if (!rolloutPath) return false; // ephemeral sessions are not memory sources
	try { fs.statSync(rolloutPath); } catch { return false; }
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) return false;
	// This hook runs for an active session, so wall-clock activity is more
	// authoritative than filesystem mtime (which may be restored or touched).
	memoryCore.upsertSession(getDb(), sessionId, rolloutPath, Date.now(), ctx.cwd);
	if (AUTO_ENQUEUE) memoryCore.requestSessionScan(getDb(), sessionId);
	return true;
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker: ChildProcess | null = null;
let workerConfig: Record<string, unknown> | null = null;
let workerToken: string | null = null;
let workerStopping = false;
const workerOwnerId = `pi-${process.pid}-${randomUUID()}`;

function resolveExtractModel(ctxModel: unknown): { baseUrl: string; model: string; phase2Model: string; apiKey: string; maxTokens?: number; contextWindow?: number } {
	const m = ctxModel as { baseUrl?: string; id?: string; provider?: string; contextWindow?: number } | undefined;
	// baseUrl/apiKey remain in the worker config for compatibility; inference is
	// performed by pi's selected provider runtime rather than direct HTTP calls.
	const baseUrl = process.env.PI_MEMORY_BASE_URL || m?.baseUrl || "https://ark.cn-beijing.volces.com/api/coding/v3";
	const activeModel = m?.id ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "";
	const model = EXTRACT_MODEL || activeModel;
	const phase2Model = process.env.PI_MEMORY_PHASE2_MODEL || model;
	const keys = (process.env.ARK_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
	const apiKey = keys[0] || process.env.ARK_API_KEY || (m?.provider ? process.env[`${m.provider.toUpperCase()}_API_KEY`] : "") || "placeholder";
	const maxTokens = Number(process.env.PI_MEMORY_EXTRACT_MAX_TOKENS) || 2048;
	// Never reuse the active model's context window for a different override.
	// The selected default is known from TraeX's live catalog; unknown overrides
	// intentionally fall back to the core 150K rollout budget.
	const contextWindow = model === DEFAULT_MEMORY_MODEL
		? DEFAULT_MEMORY_CONTEXT_WINDOW
		: model === activeModel && Number(m?.contextWindow) > 0 ? Number(m?.contextWindow) : undefined;
	return { baseUrl, model, phase2Model, apiKey, maxTokens, contextWindow };
}

function startWorker(ctxModel: unknown): boolean {
	if (worker || workerStopping) return Boolean(worker);
	const token = randomUUID();
	const d = getDb();
	if (!memoryCore.claimWorkerLease(d, WORKER_LEASE_KEY, workerOwnerId, token, WORKER_LEASE_MS)) return false;
	const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "worker.cjs");
	workerConfig = {
		dbPath: DB_PATH,
		memDir: MEMORY_DIR,
		pollMs: WORKER_POLL_MS,
		minRolloutIdleMs: MIN_ROLLOUT_IDLE_HOURS * 3600_000,
		maxRolloutAgeMs: MAX_ROLLOUT_AGE_DAYS * 24 * 3600_000,
		scanLimit: SCAN_LIMIT,
		maxRolloutsPerStartup: MAX_ROLLOUTS_PER_STARTUP,
		llm: resolveExtractModel(ctxModel),
		coordinator: { leaseKey: WORKER_LEASE_KEY, ownerId: workerOwnerId, token, leaseMs: WORKER_LEASE_MS, heartbeatMs: WORKER_HEARTBEAT_MS },
	};
	try {
		// Never inherit worker stderr into the TUI: repeated phase1 failures can
		// consume the footer and shrink the input editor. Persist diagnostics to a
		// local log; opt into live TUI output only for debugging.
		fs.mkdirSync(MEMORY_DIR, { recursive: true });
		worker = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
		workerToken = token;
		worker.stderr?.on("data", (chunk: Buffer) => {
			try { fs.appendFileSync(WORKER_LOG_PATH, chunk); } catch { /* best-effort */ }
			if (WORKER_TUI_LOGS) process.stderr.write(chunk);
		});
		worker.send({ type: "config", config: workerConfig });
		worker.on("exit", () => {
			// The child normally releases first; this is a token-safe fallback for
			// startup failures and forced termination.
			if (workerToken === token) {
				try { memoryCore.releaseWorkerLease(getDb(), WORKER_LEASE_KEY, token); } catch { /* best-effort */ }
				workerToken = null;
			}
			worker = null;
			workerStopping = false;
		});
		return true;
	} catch (error) {
		memoryCore.releaseWorkerLease(d, WORKER_LEASE_KEY, token);
		worker = null;
		workerToken = null;
		throw error;
	}
}

function stopWorker(): void {
	if (!worker || workerStopping) return;
	workerStopping = true;
	try {
		worker.send({ type: "shutdown" });
	} catch {
		worker.kill();
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

function buildRecallBlock(): string {
	ensureLayout();
	try {
		const summary = fs.readFileSync(path.join(MEMORY_DIR, "memory_summary.md"), "utf8").trim();
		if (!summary || summary === "v1\n\n## User Profile\n\n(empty)") return "";
		return memoryCore.buildMemoryRecallPrompt(MEMORY_DIR, summary, SUMMARY_TOKEN_LIMIT);
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
		pi.on("before_agent_start", async (event) => {
			try {
				const block = buildRecallBlock();
				if (!block) return;
				return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
			} catch {
				return undefined;
			}
		});

		pi.on("message_end", async (event) => {
			const stripped = memoryCore.stripAssistantMemoryCitations(event.message);
			if (stripped.sessionIds.length > 0) {
				memoryCore.recordMemoryCitationUsage(getDb(), stripped.sessionIds);
			}
			if (stripped.message !== event.message) return { message: stripped.message };
			return undefined;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// When running as a phase-2 consolidation agent (forked by the worker),
		// never fork another worker — the child only edits the memory workspace.
		if (process.env.PI_MEMORY_AGENT_CHILD === "1") return;
		indexCurrentSession(ctx);
		startWorker(ctx.model);
	});

	pi.on("session_shutdown", async () => {
		stopWorker();
	});

	if (AUTO_ENQUEUE) {
		pi.on("agent_settled", async (_event, ctx) => {
			try {
				// O(1): each pi session maintains only its own source row. The global
				// leader queries indexed idle sessions and creates Phase-1 jobs.
				indexCurrentSession(ctx);
				// Every settled turn is also a takeover opportunity.
				if (!worker) startWorker(ctx.model);
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
			const indexedSessions = (() => {
				try { return Number((getDb().prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n?: number })?.n ?? 0); } catch { return 0; }
			})();
			const globalWorker = (() => {
				try { return memoryCore.inspectWorkerLease(getDb(), WORKER_LEASE_KEY); } catch { return null; }
			})();
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
					`worker: ${globalWorker && Number(globalWorker.lease_until) > Date.now() ? `leader ${globalWorker.owner_id} (lease until ${new Date(Number(globalWorker.lease_until)).toISOString()})` : "no active global leader"}`,
					`local_worker: ${worker ? `pid ${worker.pid}` : "none"}`,
					`worker_log: ${WORKER_LOG_PATH}`,
					`indexed_sessions: ${indexedSessions}`,
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
