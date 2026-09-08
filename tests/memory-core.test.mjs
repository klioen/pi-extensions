import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	SCHEMA,
	phase1Prompt,
	parseJsonObj,
	repairJsonText,
	redactSecrets,
	sessionTranscriptFromJsonl,
	upsertPhase1Job,
} from "../packages/memory/lib/memory-core.cjs";

// --- SCHEMA：包含 jobs + stage1_outputs 表 ---
test("SCHEMA defines jobs and stage1_outputs tables", () => {
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS jobs/);
	assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS stage1_outputs/);
	assert.match(SCHEMA, /input_watermark INTEGER/); // codex watermark 幂等字段
	assert.match(SCHEMA, /generated_at INTEGER/); // codex stage-1 audit timestamp
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
	const parsed = sessionTranscriptFromJsonl(jsonl, 120);
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

test("upsertPhase1Job never overwrites an active lease", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
	const db = new DatabaseSync(join(dir, "memory.db"));
	try {
		db.exec(SCHEMA);
		assert.equal(upsertPhase1Job(db, "thread-1", 100, { rolloutPath: "old" }, 1), true);
		db.prepare("UPDATE jobs SET status='leased', ownership_token='owner', lease_until=999999").run();
		assert.equal(upsertPhase1Job(db, "thread-1", 200, { rolloutPath: "new" }, 2), false);
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
		assert.equal(upsertPhase1Job(db, "thread-1", 100, { v: 1 }, 1), true);
		// Simulate a completed first extraction: same watermark is now idempotent.
		db.prepare("INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary) VALUES ('thread-1', 100, 'm', 's')").run();
		db.prepare("UPDATE jobs SET status='completed'").run();
		assert.equal(upsertPhase1Job(db, "thread-1", 100, { v: 2 }, 2), false);
		assert.equal(upsertPhase1Job(db, "thread-1", 200, { v: 2 }, 2), true);
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
		assert.equal(upsertPhase1Job(db, "thread-1", 100, { v: 1 }, 1), true);
		db.prepare("UPDATE jobs SET status='completed'").run();
		// No stage1_outputs row exists (retention deleted it): same source must requeue.
		assert.equal(upsertPhase1Job(db, "thread-1", 100, { v: 2 }, 2), true);
		assert.match(db.prepare("SELECT payload FROM jobs").get().payload, /"v":2/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
