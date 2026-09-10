import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	SCHEMA,
	DEFAULT_ROLLOUT_TOKEN_LIMIT,
	claimWorkerLease,
	heartbeatWorkerLease,
	inspectWorkerLease,
	upsertSession,
	requestSessionScan,
	pendingSessionScan,
	completeSessionScan,
	selectIdleSessions,
	estimateTextTokens,
	resolveRolloutTokenBudget,
	truncateTextToTokenBudget,
	phase1PiArgs,
	phase1Prompt,
	parseJsonObj,
	repairJsonText,
	redactSecrets,
	releaseWorkerLease,
	sessionTranscriptFromJsonl,
	upsertPhase1Job,
} from "../packages/memory/lib/memory-core.cjs";

// --- SCHEMA：包含 jobs + stage1_outputs 表 ---
test("SCHEMA defines jobs and stage1_outputs tables", () => {
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS jobs/);
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS stage1_outputs/);
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS worker_leases/);
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS sessions/);
	assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_sessions_updated_at/);
	assert.match(SCHEMA, /input_watermark INTEGER/); // codex watermark 幂等字段
	assert.match(SCHEMA, /generated_at INTEGER/); // codex stage-1 audit timestamp
	assert.match(SCHEMA, /session_id TEXT PRIMARY KEY/);
	assert.doesNotMatch(SCHEMA, /thread_id/);
});

test("rollout token budget uses 70 percent of context window with 150k fallback", () => {
	assert.equal(resolveRolloutTokenBudget(200_000), 140_000);
	assert.equal(resolveRolloutTokenBudget(128_000), 89_600);
	assert.equal(resolveRolloutTokenBudget(undefined), DEFAULT_ROLLOUT_TOKEN_LIMIT);
	assert.equal(resolveRolloutTokenBudget(0), DEFAULT_ROLLOUT_TOKEN_LIMIT);
});

test("phase1 pi runtime args preserve providers but disable tools and persistence", () => {
	const args = phase1PiArgs("traex/gpt-5.6-sol");
	for (const flag of ["--print", "--no-session", "--no-tools", "--no-skills", "--no-context-files"]) assert.ok(args.includes(flag));
	assert.equal(args.includes("--no-extensions"), false);
	assert.deepEqual(args.slice(-2), ["--model", "traex/gpt-5.6-sol"]);
});

test("token-aware truncation preserves head and tail", () => {
	const text = `EARLY-${"x".repeat(100)}-RECENT`;
	assert.equal(estimateTextTokens("12345"), 2);
	const truncated = truncateTextToTokenBudget(text, 20);
	assert.match(truncated, /^EARLY-/);
	assert.match(truncated, /RECENT$/);
	assert.match(truncated, /rollout middle omitted for token budget/);
	assert.ok(estimateTextTokens(truncated) <= 20);
});

// --- phase1Prompt：包含 transcript 和提取指令 ---
test("phase1Prompt embeds the transcript", () => {
	const prompt = phase1Prompt("hello world", "/tmp/rollout.jsonl", "/tmp");
	assert.match(prompt, /hello world/);
	assert.match(prompt, /\/tmp\/rollout\.jsonl/);
});

// --- repairJsonText：修复模型输出里的损坏 JSON ---
test("repairJsonText fixes common truncation damage", () => {
	// 未闭合的对象
	const repaired = repairJsonText('{"a": 1, "b": {"c": 2');
	assert.match(repaired, /"a":\s*1/);
	assert.match(repaired, /"c":\s*2/);
});

test("repairJsonText removes trailing commas before closers", () => {
	const repaired = repairJsonText('{"a": [1, 2,], "b": 1,}');
	assert.match(repaired, /"a":\s*\[1,\s*2\]/);
	assert.equal(repaired.includes(",]"), false);
	assert.equal(repaired.includes(",}"), false);
});

test("repairJsonText converts single quotes and bare keys", () => {
	const repaired = repairJsonText("{'a': 'v', b: 1}");
	assert.match(repaired, /"a":\s*"v"/);
	assert.match(repaired, /"b":\s*1/);
});

// --- parseJsonObj：容忍代码块围栏和前后噪音 ---
test("parseJsonObj strips markdown fences", () => {
	const obj = parseJsonObj('```json\n{"key": "value"}\n```');
	assert.deepEqual(obj, { key: "value" });
});

test("parseJsonObj returns null on hopeless input", () => {
	assert.equal(parseJsonObj("totally not json"), null);
});

test("parseJsonObj parses plain json", () => {
	assert.deepEqual(parseJsonObj('{"n": 42}'), { n: 42 });
});

// --- deterministic secret redaction (must not depend on the LLM following a prompt) ---
test("redactSecrets removes common credentials", () => {
	const input = [
		"api_key=super-secret-value",
		"Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
		"github_pat_abcdefghijklmnopqrstuvwxyz123456",
		"https://user:password@example.com/private",
	].join("\n");
	const out = redactSecrets(input);
	assert.doesNotMatch(out, /super-secret-value|password|github_pat_abcdefghijklmnopqrstuvwxyz123456/);
	assert.match(out, /\[REDACTED_SECRET\]/);
});

// --- full rollout parser: preserve early framing + recent decisions under a budget ---
test("sessionTranscriptFromJsonl reads full session and preserves head plus tail", () => {
	const entry = (id, role, text, timestamp) => JSON.stringify({
		type: "message", id, timestamp,
		message: { role, content: [{ type: "text", text }] },
	});
	const jsonl = [
		JSON.stringify({ type: "session", cwd: "/project" }),
		entry("u1", "user", "EARLY-PROBLEM", "2026-01-01T00:00:00.000Z"),
		entry("a1", "assistant", "x".repeat(200), "2026-01-01T00:01:00.000Z"),
		entry("u2", "user", "RECENT-DECISION", "2026-01-01T00:02:00.000Z"),
	].join("\n");
	const parsed = sessionTranscriptFromJsonl(jsonl, 30);
	assert.equal(parsed.cwd, "/project");
	assert.match(parsed.transcript, /EARLY-PROBLEM/);
	assert.match(parsed.transcript, /RECENT-DECISION/);
	assert.ok(parsed.lastTs > 0);
});

// --- P0: duplicate scans must never reset a leased job / ownership token ---
test("sessionTranscriptFromJsonl preserves tool calls/results but excludes thinking", () => {
	const jsonl = [
		JSON.stringify({ type: "session", cwd: "/project" }),
		JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: {
			role: "assistant", content: [
				{ type: "thinking", thinking: "private chain of thought" },
				{ type: "toolCall", name: "bash", arguments: { command: "git status", api_key: "super-secret" } },
			],
		} }),
		JSON.stringify({ type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: {
			role: "toolResult", toolName: "bash", content: [{ type: "text", text: "M src/index.ts" }],
		} }),
	].join("\n");
	const parsed = sessionTranscriptFromJsonl(jsonl, 10_000);
	assert.match(parsed.transcript, /tool_call:bash/);
	assert.match(parsed.transcript, /git status/);
	assert.match(parsed.transcript, /\[toolResult\] M src\/index\.ts/);
	assert.doesNotMatch(parsed.transcript, /private chain of thought|super-secret/);
	assert.match(parsed.transcript, /\[REDACTED_SECRET\]/);
});

test("sessions index stores one row per session and updates it in place", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-sessions-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(upsertSession(db, "session-a", "/a.jsonl", 100, "/project-a", 101), true);
		assert.equal(upsertSession(db, "session-a", "/a.jsonl", 200, "/project-b", 201), true);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
		assert.deepEqual({ ...db.prepare("SELECT session_id,rollout_path,updated_at,cwd,last_seen_at FROM sessions").get() }, {
			session_id: "session-a", rollout_path: "/a.jsonl", updated_at: 200, cwd: "/project-b", last_seen_at: 201,
		});
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("idle session query excludes current session and obeys age window", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-sessions-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		for (const [id, updated] of [["current", 850], ["fresh", 950], ["eligible-new", 800], ["eligible-old", 600], ["expired", 100]]) {
			upsertSession(db, id, `/${id}.jsonl`, updated, "/project", 1000);
		}
		assert.deepEqual(selectIdleSessions(db, "current", 1000, 100, 500, 10).map((row) => row.session_id), ["eligible-new", "eligible-old"]);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("idle query filters up-to-date sessions before applying its limit", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-sessions-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		for (let i = 1; i <= 5; i++) upsertSession(db, `done-${i}`, `/done-${i}.jsonl`, 800 + i, "/project", 1000);
		for (let i = 1; i <= 2; i++) upsertSession(db, `todo-${i}`, `/todo-${i}.jsonl`, 700 + i, "/project", 1000);
		for (let i = 1; i <= 5; i++) {
			upsertPhase1Job(db, `done-${i}`, 800 + i, { rolloutPath: `/done-${i}.jsonl` }, 900);
			db.prepare("UPDATE jobs SET status='completed' WHERE job_key=?").run(`done-${i}`);
			db.prepare("INSERT INTO stage1_outputs (session_id,source_updated_at,raw_memory,rollout_summary) VALUES (?,?,?,?)").run(`done-${i}`, 800 + i, "m", "s");
		}
		assert.deepEqual(selectIdleSessions(db, "current", 1000, 100, 500, 2).map((row) => row.session_id), ["todo-2", "todo-1"]);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session scan generations coalesce without losing a newer request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-sessions-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(requestSessionScan(db, "session-a", "phase1", 100), 1);
		const first = pendingSessionScan(db);
		assert.equal(first.current_session_id, "session-a");
		assert.equal(requestSessionScan(db, "session-b", "phase1", 101), 2);
		assert.equal(completeSessionScan(db, first.requested_generation), true);
		const pending = pendingSessionScan(db);
		assert.equal(pending.requested_generation, 2);
		assert.equal(pending.completed_generation, 1);
		assert.equal(pending.current_session_id, "session-b");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("worker leader lease has one winner and token-safe handoff", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-leader-test-"));
	const dbPath = join(dir, "memory.db");
	const db1 = new DatabaseSync(dbPath);
	const db2 = new DatabaseSync(dbPath);
	try {
		db1.exec("PRAGMA journal_mode=WAL;");
		db1.exec(SCHEMA);
		assert.equal(claimWorkerLease(db1, "global-worker", "parent-1", "token-1", 100, 1_000), true);
		assert.equal(claimWorkerLease(db2, "global-worker", "parent-2", "token-2", 100, 1_001), false);
		assert.equal(inspectWorkerLease(db2, "global-worker").owner_id, "parent-1");
		assert.equal(heartbeatWorkerLease(db1, "global-worker", "token-1", 100, 1_050), true);
		assert.equal(heartbeatWorkerLease(db2, "global-worker", "token-2", 100, 1_050), false);
		assert.equal(releaseWorkerLease(db2, "global-worker", "token-2"), false);
		assert.equal(releaseWorkerLease(db1, "global-worker", "token-1"), true);
		assert.equal(claimWorkerLease(db2, "global-worker", "parent-2", "token-2", 100, 1_051), true);
	} finally {
		db1.close();
		db2.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expired worker lease can be replaced and stale token cannot affect successor", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-leader-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(claimWorkerLease(db, "global-worker", "old", "old-token", 10, 100), true);
		assert.equal(claimWorkerLease(db, "global-worker", "new", "new-token", 100, 111), true);
		assert.equal(heartbeatWorkerLease(db, "global-worker", "old-token", 100, 112), false);
		assert.equal(releaseWorkerLease(db, "global-worker", "old-token"), false);
		const lease = inspectWorkerLease(db, "global-worker");
		assert.equal(lease.owner_id, "new");
		assert.equal(lease.ownership_token, "new-token");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("upsertPhase1Job never overwrites an active lease", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(upsertPhase1Job(db, "session-1", 100, { rolloutPath: "old" }, 1), true);
		db.prepare("UPDATE jobs SET status='leased', ownership_token='owner', lease_until=999999").run();
		assert.equal(upsertPhase1Job(db, "session-1", 200, { rolloutPath: "new" }, 2), false);
		const row = db.prepare("SELECT status, ownership_token, input_watermark, payload FROM jobs").get();
		assert.equal(row.status, "leased");
		assert.equal(row.ownership_token, "owner");
		assert.equal(row.input_watermark, 100);
		assert.match(row.payload, /old/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("upsertPhase1Job advances only completed/pending jobs with newer watermark", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(upsertPhase1Job(db, "session-1", 100, { v: 1 }, 1), true);
		// Simulate a completed first extraction: same watermark is now idempotent.
		db.prepare("INSERT INTO stage1_outputs (session_id, source_updated_at, raw_memory, rollout_summary) VALUES ('session-1', 100, 'm', 's')").run();
		db.prepare("UPDATE jobs SET status='completed'").run();
		assert.equal(upsertPhase1Job(db, "session-1", 100, { v: 2 }, 2), false);
		assert.equal(upsertPhase1Job(db, "session-1", 200, { v: 2 }, 2), true);
		const row = db.prepare("SELECT input_watermark, payload FROM jobs").get();
		assert.equal(row.input_watermark, 200);
		assert.match(row.payload, /"v":2/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("upsertPhase1Job requeues a completed rollout after retention prunes its output", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(upsertPhase1Job(db, "session-1", 100, { v: 1 }, 1), true);
		db.prepare("UPDATE jobs SET status='completed'").run();
		// No stage1_outputs row exists (retention deleted it): same source must requeue.
		assert.equal(upsertPhase1Job(db, "session-1", 100, { v: 2 }, 2), true);
		assert.match(db.prepare("SELECT payload FROM jobs").get().payload, /"v":2/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
