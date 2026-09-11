import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	openMemoryObservatory,
	queryOverview,
	queryWorkers,
	queryJobs,
	querySessions,
	queryPhase1,
	queryPhase1Detail,
	queryPhase1Content,
	queryPhase2,
	queryArtifacts,
	queryArtifactDetail,
	queryArtifactContent,
	queryLogs,
} from "../packages/pi-web/lib/memory-observatory-core.cjs";
import { SCHEMA } from "../packages/memory/lib/memory-core.cjs";

function fixture(run) {
	const memoryDir = mkdtempSync(join(tmpdir(), "pi-web-memory-observatory-"));
	const dbPath = join(memoryDir, "memory.db");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(SCHEMA);
	db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const now = 2_000_000;
	db.prepare(`INSERT INTO worker_leases VALUES (?,?,?,?,?,?)`).run("global-worker", "worker-1", "TOP-SECRET-TOKEN", now + 10_000, now - 10, now - 100);
	db.prepare(`INSERT INTO worker_leases VALUES (?,?,?,?,?,?)`).run("old-worker", "worker-old", "OLD-TOKEN", now - 1, now - 100, now - 200);
	const job = db.prepare(`INSERT INTO jobs
		(kind,job_key,status,worker_id,ownership_token,payload,lease_until,retry_until,retry_remaining,last_error,created_at,finished_at,started_at,input_watermark,last_success_watermark)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	job.run("phase1", "session-a", "leased", "worker-1", "JOB-TOKEN", '{"api_key":"never-return"}', now + 5000, null, 3, null, now - 1000, null, now - 50, 1000, null);
	job.run("phase1", "session-b", "failed", null, null, "{}", null, now + 1000, 2, "Authorization: Bearer abcdefghijklmnop", now - 900, null, now - 40, 900, null);
	job.run("memory_consolidate_global", "consolidation", "completed", null, null, "{}", null, null, 3, null, now - 800, now - 10, now - 20, 1000, 1000);
	const output = db.prepare(`INSERT INTO phase1_outputs
		(session_id,source_updated_at,raw_memory,rollout_summary,generated_at,rollout_slug,cwd,rollout_path,git_branch,usage_count,last_usage,selected_for_phase2,selected_for_phase2_source_updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	output.run("session-a", 1000, "raw secret-ish memory", "Summary A", 1100, "alpha", "/Users/private/project-a", "/Users/private/a.jsonl", "main", 2, 1200, 1, 1000);
	output.run("session-b", 900, "Raw B", "Summary B", 950, "beta", "/Users/private/project-b", "/Users/private/b.jsonl", null, 0, null, 0, null);
	const session = db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?)`);
	session.run("session-a", "/private/a.jsonl", 1000, "/private/project-a", 1100);
	session.run("session-b", "/private/b.jsonl", 1000, "/private/project-b", 1100);
	for (let index = 0; index < 130; index++) session.run(`indexed-${String(index).padStart(3, "0")}`, `/private/${index}.jsonl`, 1000 - index, `/private/project-${index}`, 1100 - index);
	db.prepare(`INSERT INTO session_scan_state VALUES (?,?,?,?,?)`).run("phase1", 3, 2, now - 20, "current-secret-session");
	db.prepare(`INSERT INTO kv VALUES (?,?)`).run("phase2_last_success_at", JSON.stringify(now - 10));
	db.prepare(`INSERT INTO kv VALUES (?,?)`).run("phase2_last_watermark", JSON.stringify(1000));

	mkdirSync(join(memoryDir, "rollout_summaries"));
	const rolloutName = "1970-01-01T00-00-01-000-alpha-session-.md";
	writeFileSync(join(memoryDir, "rollout_summaries", rolloutName), [
		"session_id: session-a", "updated_at: 1970-01-01T00:00:01.000Z", "rollout_path: /Users/private/a.jsonl", "cwd: /Users/private/project-a", "", "Summary A", "",
	].join("\n"));
	writeFileSync(join(memoryDir, "memory_summary.md"), "v1\nsummary\n");
	writeFileSync(join(memoryDir, "MEMORY.md"), "# MEMORY\n");
	writeFileSync(join(memoryDir, "raw_memories.md"), "# Raw Memories\n\n## Session `session-a`\nupdated_at: 1970-01-01T00:00:01.000Z\n\nraw secret-ish memory\n");
	mkdirSync(join(memoryDir, "skills", "nested"), { recursive: true });
	writeFileSync(join(memoryDir, "skills", "README.md"), "skills index\n");
	writeFileSync(join(memoryDir, "skills", "nested", "SKILL.md"), "token=sk-abcdefghijklmnop\npath=/Users/private/skill\n");
	writeFileSync(join(memoryDir, "worker.log"), "info start\nAuthorization: Bearer abcdefghijklmnop\ninfo done\n");
	try { return run({ memoryDir, dbPath, db, now, rolloutName }); }
	finally { db.close(); rmSync(memoryDir, { recursive: true, force: true }); }
}

function serialized(value) { return JSON.stringify(value); }

test("opens SQLite read-only, sees WAL data, and probes schema capabilities", () => fixture(({ memoryDir, dbPath }) => {
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		assert.equal(observatory.availability.available, true);
		assert.equal(observatory.capabilities.tables.jobs.available, true);
		assert.equal(observatory.capabilities.tables.jobs.columns.includes("payload"), false);
		assert.equal(queryJobs(observatory).items.length, 3);
		assert.throws(() => observatory.db.exec("DELETE FROM jobs"), /readonly/i);
	} finally { observatory.close(); }
}));

test("missing and old schemas degrade through capabilities instead of throwing", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-web-memory-missing-"));
	try {
		const missing = openMemoryObservatory({ dbPath: join(directory, "missing.db"), memoryDir: directory });
		assert.equal(missing.availability.available, false);
		assert.deepEqual(queryJobs(missing), { items: [], page: { limit: 50, offset: 0, returned: 0, hasMore: false }, unavailable: "jobs table is unavailable" });
		const oldPath = join(directory, "old.db");
		const db = new DatabaseSync(oldPath); db.exec("CREATE TABLE jobs(kind TEXT, job_key TEXT, status TEXT)"); db.close();
		const old = openMemoryObservatory({ dbPath: oldPath, memoryDir: directory });
		try { assert.equal(queryJobs(old).items[0], undefined); assert.equal(old.capabilities.features.jobs, false); }
		finally { old.close(); }
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("overview, workers, and jobs derive states without leaking payload or ownership tokens", () => fixture(({ memoryDir, dbPath, now }) => {
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const overview = queryOverview(observatory, { now });
		assert.equal(overview.counts.jobs, 3);
		assert.equal(overview.counts.phase1, 2);
		assert.equal(overview.counts.sessions, 132);
		assert.equal(overview.counts.artifacts, 5);
		assert.equal(overview.scanState.state, "pending");
		assert.equal(overview.scanState.requestedGeneration, 3);
		assert.equal(overview.lastPhase1At, 1100);
		assert.equal(overview.lastPhase2At, now - 10);
		assert.equal(overview.recallUsage, 2);
		assert.deepEqual(overview.recallUsageSummary, { total: 2, usedOutputs: 1, lastUsedAt: 1200 });
		assert.equal(overview.artifacts.consistency, "consistent");
		assert.deepEqual(overview.pipeline.map((stage) => stage.name), ["Session scan", "Phase 1 extraction", "Phase 2 consolidation", "Artifact publication"]);
		assert.equal(overview.pipeline[0].status, "pending");
		assert.equal(queryWorkers(observatory, { now }).items[0].state, "active");
		assert.equal(queryWorkers(observatory, { now }).items[1].state, "expired");
		const jobs = queryJobs(observatory, { now }).items;
		assert.equal(jobs.find((item) => item.jobKey === "session-a").state, "running");
		assert.equal(jobs.find((item) => item.jobKey === "session-b").state, "retry-wait");
		assert.doesNotMatch(serialized({ overview, jobs, workers: queryWorkers(observatory, { now }) }), /payload|ownership_token|TOP-SECRET|JOB-TOKEN|abcdefghijklmnop/);
	} finally { observatory.close(); }
}));

test("sessions and phase1 use bounded pagination and omit private source paths", () => fixture(({ memoryDir, dbPath }) => {
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const first = querySessions(observatory, { limit: 500, offset: 0 });
		assert.equal(first.items.length, 100);
		assert.equal(first.page.limit, 100);
		assert.equal(first.page.hasMore, true);
		assert.doesNotMatch(serialized(first), /private|rolloutPath|cwd/);
		const sessions = querySessions(observatory, { q: "session-", now: 2_000_000 }).items;
		assert.equal(sessions.find((item) => item.sessionId === "session-a").scanStatus, "running");
		assert.equal(sessions.find((item) => item.sessionId === "session-a").phase1State, "up-to-date");
		assert.equal(sessions.find((item) => item.sessionId === "session-a").phase1Status, "up-to-date");
		assert.equal(sessions.find((item) => item.sessionId === "session-b").scanStatus, "retry-wait");
		assert.equal(sessions.find((item) => item.sessionId === "session-b").phase1State, "stale");
		const phase1 = queryPhase1(observatory, { limit: 1 });
		assert.equal(phase1.items.length, 1);
		assert.equal(phase1.items[0].rawMemoryBytes, Buffer.byteLength("raw secret-ish memory"));
		assert.equal(phase1.items[0].rolloutSummaryBytes, Buffer.byteLength("Summary A"));
		assert.doesNotMatch(serialized(phase1), /raw secret-ish memory|\/Users\/private/);
		assert.deepEqual(queryPhase1(observatory, { selected: true }).items.map((item) => item.sessionId), ["session-a"]);
		assert.deepEqual(queryPhase1(observatory, { selected: false }).items.map((item) => item.sessionId), ["session-b"]);
		assert.deepEqual(queryPhase1(observatory, { used: true, q: "alpha" }).items.map((item) => item.sessionId), ["session-a"]);
		assert.deepEqual(queryPhase1(observatory, { used: false, q: "session-b" }).items.map((item) => item.sessionId), ["session-b"]);
	} finally { observatory.close(); }
}));

test("phase1 detail remains metadata-only and content is explicit, field-allowlisted, and bounded", () => fixture(({ memoryDir, dbPath }) => {
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const detail = queryPhase1Detail(observatory, "session-a");
		assert.equal(detail.sessionId, "session-a");
		assert.equal(detail.materialized.consistent, true);
		assert.doesNotMatch(serialized(detail), /raw secret-ish memory|\/Users\/private/);
		assert.deepEqual(queryPhase1Content(observatory, "session-a", "rolloutSummary", { maxBytes: 4 }), { field: "rolloutSummary", sensitive: true, content: "Summ", bytes: 4, totalBytes: 9, truncated: true });
		assert.throws(() => queryPhase1Content(observatory, "session-a", "payload"), /field/i);
	} finally { observatory.close(); }
}));

test("phase2 and artifact overview expose exactly five fixed top-level resources with mtime metadata", () => fixture(({ memoryDir, dbPath }) => {
	const modified = new Date("2026-09-11T12:34:56.000Z");
	utimesSync(join(memoryDir, "memory_summary.md"), modified, modified);
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const phase2 = queryPhase2(observatory);
		assert.equal(phase2.selectedOutputs.length, 1);
		assert.equal(phase2.watermark, 1000);
		assert.equal(phase2.consistency, "consistent");
		assert.deepEqual(phase2.recallUsage, { total: 2, usedOutputs: 1, lastUsedAt: 1200 });
		const artifacts = queryArtifacts(observatory);
		assert.deepEqual(artifacts.items.map((item) => item.id), ["memory-summary", "memory-handbook", "raw-memories", "rollout-summaries", "memory-skills"]);
		assert.deepEqual(artifacts.items.map((item) => item.kind), ["file", "file", "file", "directory", "directory"]);
		assert.equal(artifacts.items.find((item) => item.id === "memory-summary").modifiedAt, modified.toISOString());
		assert.equal(artifacts.items.find((item) => item.id === "rollout-summaries").itemCount, 1);
		assert.equal(artifacts.items.find((item) => item.id === "memory-skills").itemCount, 2);
		assert.doesNotMatch(serialized({ phase2, artifacts }), /payload|ownership_token|\/Users\/private/);
	} finally { observatory.close(); }
}));

test("directory artifact details enumerate only safe allowlisted regular files with stable child ids", () => fixture(({ memoryDir, dbPath, rolloutName }) => {
	const outside = join(memoryDir, "..", "outside-secret.md");
	writeFileSync(outside, "SECRET_OUTSIDE");
	writeFileSync(join(memoryDir, "rollout_summaries", "ignored.txt"), "ignored");
	symlinkSync(outside, join(memoryDir, "rollout_summaries", "escaped.md"));
	symlinkSync(outside, join(memoryDir, "skills", "escaped.md"));
	symlinkSync(join(memoryDir, "skills", "nested"), join(memoryDir, "skills", "linked-dir"));
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const rollouts = queryArtifactDetail(observatory, "rollout-summaries");
		assert.deepEqual(rollouts.entries.map((item) => item.name), [rolloutName]);
		assert.match(rollouts.entries[0].id, /^rollout-file-[a-f0-9]{24}$/);
		assert.deepEqual(queryArtifactDetail(observatory, rollouts.entries[0].id), rollouts.entries[0]);
		const skills = queryArtifactDetail(observatory, "memory-skills");
		assert.deepEqual(skills.entries.map((item) => item.name), ["README.md", "nested/SKILL.md"]);
		assert.match(skills.entries[1].id, /^skill-file-[a-f0-9]{24}$/);
		assert.deepEqual(queryArtifactDetail(observatory, skills.entries[1].id), skills.entries[1]);
		assert.doesNotMatch(serialized({ rollouts, skills }), /SECRET_OUTSIDE|outside-secret|\/Users\//);
		assert.deepEqual(queryArtifactDetail(observatory, "memory-skills"), skills);
		const content = queryArtifactContent(observatory, skills.entries[1].id, { maxBytes: 64 });
		assert.match(content.content, /REDACTED_SECRET/);
		assert.match(content.content, /REDACTED_PATH/);
		assert.doesNotMatch(content.content, /abcdefghijklmnop|\/Users\/private/);
		assert.throws(() => queryArtifactDetail(observatory, "unknown"), /artifact/i);
		assert.throws(() => queryArtifactContent(observatory, "../../etc/passwd"), /artifact/i);
	} finally { observatory.close(); rmSync(outside, { force: true }); }
}));

test("artifact file content is independently allowlisted, bounded, and sanitized", () => fixture(({ memoryDir, dbPath }) => {
	writeFileSync(join(memoryDir, "MEMORY.md"), `# MEMORY\n${"x".repeat(2 * 1024 * 1024)}\npath: /Users/private/project`);
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const bounded = queryArtifactContent(observatory, "memory-handbook", { maxBytes: 64 });
		assert.equal(Buffer.byteLength(bounded.content), 64);
		assert.equal(bounded.bytes, 64);
		assert.equal(bounded.totalBytes, 2 * 1024 * 1024 + 38);
		assert.equal(bounded.truncated, true);
		assert.throws(() => queryArtifactContent(observatory, "rollout-summaries"), /content/i);
	} finally { observatory.close(); }
}));

test("logs are tail-bounded and redact common credentials", () => fixture(({ memoryDir, dbPath }) => {
	const observatory = openMemoryObservatory({ dbPath, memoryDir });
	try {
		const logs = queryLogs(observatory, { lines: 2, maxBytes: 1024 });
		assert.equal(logs.lines.length, 2);
		assert.match(logs.lines[0], /REDACTED/);
		assert.doesNotMatch(serialized(logs), /abcdefghijklmnop/);
	} finally { observatory.close(); }
}));
