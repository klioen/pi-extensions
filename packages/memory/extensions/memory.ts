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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEMORY_DIR = (process.env.PI_MEMORY_DIR || path.join(os.homedir(), ".pi", "agent", "memories")).replace(/\/+$/, "");
const DB_PATH = path.join(MEMORY_DIR, "memory.db");
const RECALL_ENABLED = process.env.PI_MEMORY_RECALL !== "0";
const AUTO_ENQUEUE = process.env.PI_MEMORY_AUTO !== "0";
const SUMMARY_TOKEN_LIMIT = Math.max(500, Number(process.env.PI_MEMORY_SUMMARY_TOKENS) || 4000);
const ROLLOUT_CHAR_LIMIT = Math.max(4000, Number(process.env.PI_MEMORY_ROLLOUT_CHARS) || 20000);
const EXTRACT_MODEL = process.env.PI_MEMORY_EXTRACT_MODEL || ""; // optional override, like codex extract_model
const MIN_ROLLOUT_IDLE_HOURS = Math.max(0, Number(process.env.PI_MEMORY_MIN_ROLLOUT_IDLE_HOURS) ?? 6); // codex DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS=6
const WORKER_POLL_MS = Math.max(500, Number(process.env.PI_MEMORY_WORKER_POLL_MS) || 3000);

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
    rollout_slug TEXT,
    cwd TEXT,
    git_branch TEXT,
    usage_count INTEGER,
    last_usage INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_lease ON jobs(status, lease_until);
`);
	}
	return db;
}

function enqueueJob(kind: string, jobKey: string, payload: unknown): void {
	enqueueJobWithWatermark(kind, jobKey, 0, payload);
}

function enqueueJobWithWatermark(kind: string, jobKey: string, inputWatermark: number, payload: unknown): void {
	const d = getDb();
	d.prepare(
		`INSERT OR REPLACE INTO jobs (kind, job_key, status, retry_remaining, payload, input_watermark, created_at)
     VALUES (?, ?, 'pending', 3, ?, ?, ?)`,
	).run(kind, jobKey, JSON.stringify(payload), inputWatermark, Date.now());
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
	workerConfig = { dbPath: DB_PATH, memDir: MEMORY_DIR, pollMs: WORKER_POLL_MS, llm: resolveExtractModel(ctxModel) };
	worker = fork(workerPath, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--no-warnings"] });
	worker.send({ type: "config", config: workerConfig });
	worker.on("exit", (code, signal) => {
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
				const msgs = collectMessages(sm);
				if (msgs.length === 0) return;
				const state = readState<{ lastExtractedId: string | null; phase1Count: number }>(DB_STATE_KEY, {
					lastExtractedId: null,
					phase1Count: 0,
				});
				const lastIdx = state.lastExtractedId ? msgs.findIndex((m) => m.entryId === state.lastExtractedId) : -1;
				const fresh = msgs.slice(lastIdx + 1);
				if (fresh.length === 0) return;

				const transcript = fresh
					.map((m) => `[${m.role}] ${m.content.replace(/\s+/g, " ").slice(0, 3000)}`)
					.join("\n\n")
					.slice(0, ROLLOUT_CHAR_LIMIT);
				if (!transcript.trim()) return;

				const threadId = String(sm.getSessionId?.() ?? "pi");
				const phase1Count = state.phase1Count + 1;

				// Codex min_rollout_idle_hours: only extract after the conversation
				// has been idle for N hours. Default 0 = extract immediately after
				// each turn, which is the pi analog of a completed rollout.
				if (MIN_ROLLOUT_IDLE_HOURS > 0) {
					const lastTs = fresh[fresh.length - 1].ts || 0;
					if (lastTs > 0 && Date.now() - lastTs < MIN_ROLLOUT_IDLE_HOURS * 3600_000) {
						// conversation still fresh; skip phase-1 this turn
						return;
					}
				}

				// Enqueue a phase-1 job with the input watermark set to the latest
				// message timestamp. The worker claims and executes asynchronously;
				// Codex-aligned idempotency (stage1_outputs.source_updated_at >=
				// input_watermark) lets a retried/duplicate job skip harmlessly.
				// Phase-2 consolidation is triggered by the worker itself after a
				// phase-1 success (watermark advance), gated by cooldown/backoff —
				// exactly like Codex's global phase-2 singleton job.
				const inputWatermark = fresh[fresh.length - 1].ts || 0;
				enqueueJobWithWatermark("phase1", threadId, inputWatermark, {
					transcript,
					rolloutPath: String(sm.getSessionFile?.() ?? ""),
					rolloutCwd: ctx.cwd,
					threadId,
				});
				upsertState(DB_STATE_KEY, { lastExtractedId: msgs[msgs.length - 1].entryId, phase1Count });

				if (!worker) startWorker(ctx.model);
			} catch {
				/* never break the session */
			}
		});
	}

	pi.registerCommand("memory", {
		description: "pi-memory: /memory (status) | /memory consolidate | /memory path | /memory reset",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().split(/\s+/)[0];
			if (sub === "path") {
				ctx.ui.notify(`Memory dir: ${MEMORY_DIR}\nDB: ${DB_PATH}`, "info");
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
