import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPiWebServer } from "../packages/pi-web/server/server.cjs";
import { SCHEMA } from "../packages/memory/lib/memory-core.cjs";

async function withServer(run, serverOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-server-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const publicDir = join(root, "public");
	const memoryDir = join(agentDir, "memories");
	const piRootDir = join(root, "pi-root");
	mkdirSync(join(piRootDir, "cache"), { recursive: true });
	writeFileSync(join(piRootDir, "cache", "data.bin"), "123456789");
	mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(memoryDir, { recursive: true });
	mkdirSync(publicDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Pi Web</title>");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:demo", { source: "npm:nested", apiKey: "NESTED_SECRET", skills: ["skills/**"] }], extensions: [], apiKey: "SECRET_SENTINEL" }));
	writeFileSync(join(agentDir, "extensions", "demo.ts"), "export default () => {};");
	writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n");
	writeFileSync(join(memoryDir, "memory_summary.md"), "v1\n\n# Summary\n");
	writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
	writeFileSync(join(memoryDir, "raw_memories.md"), "# Raw Memories\n\nNo raw memories yet.\n");
	mkdirSync(join(memoryDir, "rollout_summaries"));
	writeFileSync(join(memoryDir, "rollout_summaries", "one.md"), "rollout one\n");
	mkdirSync(join(memoryDir, "skills", "demo"), { recursive: true });
	writeFileSync(join(memoryDir, "skills", "demo", "SKILL.md"), "memory skill\n");
	const memoryDbPath = join(agentDir, "sqlite", "memory.db");
	mkdirSync(join(agentDir, "sqlite"));
	const memoryDb = new DatabaseSync(memoryDbPath);
	memoryDb.exec(SCHEMA);
	memoryDb.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run("memory-session", join(root, "memory.jsonl"), 1000, cwd, 1100);
	memoryDb.prepare("INSERT INTO jobs (kind,job_key,status,payload,retry_remaining,created_at,input_watermark,finished_at) VALUES (?,?,?,?,?,?,?,?)").run("phase1", "memory-session", "completed", "{}", 3, 1000, 1000, 1200);
	memoryDb.prepare("INSERT INTO phase1_outputs (session_id,source_updated_at,raw_memory,rollout_summary,generated_at,rollout_slug,cwd,rollout_path,usage_count,selected_for_phase2) VALUES (?,?,?,?,?,?,?,?,?,?)").run("memory-session", 1000, "raw memory", "rollout summary", 1200, "demo", cwd, join(root, "memory.jsonl"), 1, 0);
	memoryDb.close();
	const sessionPath = join(root, "session.jsonl");
	writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: "s1", cwd, timestamp: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:01:00Z" })}\n`);
	const server = createPiWebServer({ host: "127.0.0.1", port: 0, cwd, agentDir, memoryDir, memoryDbPath, piRootDir, publicDir, projectTrusted: true, listSessions: async () => [{ id: "s1", path: sessionPath, cwd, name: "Demo", created: new Date(0), modified: new Date(1), messageCount: 1, firstMessage: "hello" }], ...serverOptions });
	try { const address = await server.start(); await run({ root, base: `http://127.0.0.1:${address.port}`, headers: { origin: `http://127.0.0.1:${address.port}` } }); }
	finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
}

async function json(response) { return response.json(); }

test("Sessions UI renders the API directory tree instead of a flat table", () => {
	const app = readFileSync(new URL("../packages/pi-web/public/app.js", import.meta.url), "utf8");
	assert.match(app, /function sessionTreeNode\(node, depth = 0\)/);
	assert.match(app, /const defaultOpen = children\.length > 0/);
	assert.match(app, /<details class="session-tree-directory"[^>]*\$\{defaultOpen \? " open" : ""\}/);
	assert.match(app, /const tree = list\(data, \["tree"\]\)/);
	assert.match(app, /<section class="sessions-workbench"><aside class="session-browser">/);
	assert.match(app, /<article class="session-detail" id="session-detail">/);
	assert.match(app, /data-action="select-session"/);
	assert.match(app, /data-action="rename-session"/);
	assert.match(app, /data-action="delete-session"/);
	assert.match(app, /async function loadSessionDetail\(id\)/);
	const treeLeaf = app.slice(app.indexOf("function sessionTreeLeaf"), app.indexOf("function sessionTreeNode"));
	assert.doesNotMatch(treeLeaf, /href="#\/sessions\//);
	assert.doesNotMatch(app, /<th>Session<\/th><th>Status<\/th><th>Updated<\/th>/);
});

test("pi-web extension routes current and historical session renames through Pi APIs", () => {
	const extension = readFileSync(new URL("../packages/pi-web/extensions/pi-web.ts", import.meta.url), "utf8");
	assert.match(extension, /listEffectiveSkills: \(\) => pi\.getCommands\(\)\.filter\(\(command\) => command\.source === "skill"\)/);
	assert.match(extension, /getCurrentSessionId: \(\) => currentSessionId/);
	assert.match(extension, /if \(current\) pi\.setSessionName\(name\)/);
	assert.match(extension, /SessionManager\.open\(session\.path\)\.appendSessionInfo\(name\)/);
});

test("Memory UI keeps health, pipeline, workers, and artifact entry points on overview only", () => {
	const app = readFileSync(new URL("../packages/pi-web/public/app.js", import.meta.url), "utf8");
	assert.doesNotMatch(app, /\["pipeline",\s*"Pipeline"\]|\["artifacts",\s*"Artifacts"\]/);
	assert.doesNotMatch(app, /memoryPage === "pipeline"|function renderMemoryPipeline|function renderArtifacts/);
	assert.match(app, /renderMemoryOverview[\s\S]*Promise\.all\(\[[\s\S]*observatory\/overview[\s\S]*observatory\/workers[\s\S]*observatory\/artifacts/);
	assert.match(app, /capabilityNotice\(overview, \{ always: true \}\)/);
	assert.match(app, /const timeLabel = updatedAt \? fmtDate\(updatedAt\)/);
	assert.match(app, /#\/memory\/artifact\/\$\{encodeURIComponent\(id\)\}/);
	assert.match(app, /const contentData = directory \? null : await api\(`\/api\/memory\/observatory\/artifacts\/\$\{encodeURIComponent\(id\)\}\/content`\)/);
	assert.doesNotMatch(app, /Load file content|load-artifact-content|function loadArtifactContent/);
});

test("pi-web serves tokenless loopback APIs and the static Control Deck", () => withServer(async ({ base, headers }) => {
	const overview = await fetch(`${base}/api/overview`);
	assert.equal(overview.status, 200);
	assert.deepEqual((await json(overview)).counts, { sessions: 1, skills: 2, extensions: 1, packages: 2 });
	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Pi Web/);
	assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
	assert.equal((await fetch(`${base}/../package.json`)).status, 404);
}));

test("pi-web exposes disk usage from the injected fixed root and validates query parameters", () => withServer(async ({ base, headers }) => {
	const response = await fetch(`${base}/api/disk-usage?path=cache&sort=name&order=asc&refresh=1`, { headers });
	assert.equal(response.status, 200);
	const result = await json(response);
	assert.equal(result.current.relativePath, "cache");
	assert.equal(result.totalSize, 9);
	assert.deepEqual(result.items.map((item) => item.name), ["data.bin"]);
	assert.doesNotMatch(JSON.stringify(result), /pi-web-server-/);
	assert.equal((await fetch(`${base}/api/disk-usage?path=..%2Foutside`, { headers })).status, 403);
	assert.equal((await fetch(`${base}/api/disk-usage?sort=unknown`, { headers })).status, 400);
	assert.equal((await fetch(`${base}/api/disk-usage?order=sideways`, { headers })).status, 400);
	assert.equal((await fetch(`${base}/api/disk-usage?refresh=yes`, { headers })).status, 400);
}));

test("pi-web injects disk usage traversal limits into the service", () => withServer(async ({ base, headers }) => {
	const result = await json(await fetch(`${base}/api/disk-usage?sort=name&order=asc`, { headers }));
	assert.equal(result.partial, true);
	assert.equal(result.items.length, 1);
	assert.ok(result.diagnostics.some((item) => item.code === "MAX_ENTRIES"));
}, { diskUsageMaxEntries: 1, diskUsageMaxDepth: 1 }));

test("pi-web exposes bounded session detail and static resource catalogs", () => withServer(async ({ root, base, headers }) => {
	const sessions = await json(await fetch(`${base}/api/sessions?q=demo`, { headers }));
	assert.equal(sessions.sessions[0].id, "s1");
	assert.equal(sessions.tree[0].name, "/");
	assert.equal(sessions.tree[0].sessionCount, 1);
	assert.doesNotMatch(JSON.stringify(sessions), /"(?:path|file)":|session\.jsonl/);
	const treeSessions = (nodes) => nodes.flatMap((node) => [...node.sessions, ...treeSessions(node.children)]);
	assert.deepEqual(treeSessions(sessions.tree).map((item) => item.id), ["s1"]);
	const detail = await json(await fetch(`${base}/api/sessions/s1`, { headers }));
	assert.equal(detail.summary.sessionId, "s1");
	assert.equal(detail.entries.length, 1);
	assert.match(detail.revision, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(JSON.stringify(detail.session), /"(?:path|file)":|session\.jsonl/);
	const extensions = await json(await fetch(`${base}/api/extensions`, { headers }));
	assert.equal(extensions.entries.length, 1);
	assert.equal(extensions.settings.packages[0].source, "npm:demo");
	assert.doesNotMatch(JSON.stringify(extensions), /SECRET_SENTINEL|NESTED_SECRET/);
	assert.deepEqual(extensions.settings.packages[1].skills, ["skills/**"]);
}));

test("pi-web renames sessions with revision checks and protects current session deletion", () => {
	let sessionPath;
	let currentFlag;
	return withServer(async ({ base, headers }) => {
		const detail = await json(await fetch(`${base}/api/sessions/s1`, { headers }));
		const renamed = await fetch(`${base}/api/sessions/s1`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed", revision: detail.revision }) });
		assert.equal(renamed.status, 200);
		assert.equal(currentFlag, true);
		assert.match(readFileSync(sessionPath, "utf8"), /"type":"session_info","name":"Renamed"/);
		const stale = await fetch(`${base}/api/sessions/s1`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Stale", revision: detail.revision }) });
		assert.equal(stale.status, 409);
		const deleted = await fetch(`${base}/api/sessions/s1`, { method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision: (await json(renamed)).revision }) });
		assert.equal(deleted.status, 409);
	}, {
		getCurrentSessionId: () => "s1",
		renameSession: (session, name, current) => {
			sessionPath = session.path;
			currentFlag = current;
			writeFileSync(session.path, `${readFileSync(session.path, "utf8")}${JSON.stringify({ type: "session_info", name })}\n`);
		},
	});
});

test("pi-web deletes a historical session after revision validation", () => withServer(async ({ base, headers }) => {
	const detail = await json(await fetch(`${base}/api/sessions/s1`, { headers }));
	const deleted = await fetch(`${base}/api/sessions/s1`, { method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision: detail.revision }) });
	assert.equal(deleted.status, 200);
	assert.equal((await json(deleted)).deleted, true);
	assert.equal((await fetch(`${base}/api/sessions/s1`, { headers })).status, 404);
}, { getCurrentSessionId: () => "other", deleteSession: (session) => { rmSync(session.path); return { method: "test" }; } }));

test("pi-web uses the effective runtime skill snapshot for listing, overview, and detail", () => {
	let runtimeSkills;
	return withServer(async ({ root, base, headers }) => {
		const userFile = join(root, "agent", "skills", "demo", "SKILL.md");
		const packageFile = join(root, "runtime-package", "skills", "packaged", "SKILL.md");
		mkdirSync(join(root, "runtime-package", "skills", "packaged"), { recursive: true });
		writeFileSync(packageFile, "---\nname: packaged\ndescription: Package skill\n---\n# Package\n");
		runtimeSkills = [
			{ name: "skill:demo", description: "Runtime demo", source: "skill", sourceInfo: { path: userFile, source: "auto", scope: "user", origin: "top-level" }, credential: "NOPE" },
			{ name: "skill:packaged", description: "Runtime package", source: "skill", sourceInfo: { path: packageFile, source: "npm:pkg", scope: "user", origin: "package" }, credential: "NOPE" },
			{ name: "not-a-skill", source: "extension", sourceInfo: { path: userFile } },
		];
		const skills = await json(await fetch(`${base}/api/skills`, { headers }));
		assert.deepEqual(skills.skills.map((skill) => skill.name), ["demo", "packaged"]);
		assert.equal(skills.skills[0].mutable, true);
		assert.equal(skills.skills[1].mutable, false);
		assert.doesNotMatch(JSON.stringify(skills), /NOPE|credential/);
		const overview = await json(await fetch(`${base}/api/overview`, { headers }));
		assert.equal(overview.counts.skills, 2);
		const detail = await json(await fetch(`${base}/api/skills/${skills.skills[1].id}`, { headers }));
		assert.match(detail.content, /# Package/);
		assert.equal(detail.skill.mutable, false);
	}, { listEffectiveSkills: () => runtimeSkills || [] });
});

test("pi-web skill writes use revisions and reject stale updates", () => withServer(async ({ base, headers }) => {
	const skills = await json(await fetch(`${base}/api/skills`, { headers }));
	const skill = skills.skills[0];
	const detail = await json(await fetch(`${base}/api/skills/${skill.id}`, { headers }));
	const next = detail.content.replace("# Demo", "# Updated");
	const updated = await fetch(`${base}/api/skills/${skill.id}`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ content: next, revision: skill.revision }) });
	assert.equal(updated.status, 200);
	const stale = await fetch(`${base}/api/skills/${skill.id}`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ content: next, revision: skill.revision }) });
	assert.equal(stale.status, 409);
}));

test("pi-web exposes read-only Memory Observatory routes without sensitive DB fields", () => withServer(async ({ base, headers }) => {
	const overviewResponse = await fetch(`${base}/api/memory/observatory/overview`, { headers });
	assert.equal(overviewResponse.status, 200);
	const overview = await json(overviewResponse);
	assert.equal(overview.meta.dbAvailable, true);
	assert.equal(overview.data.counts.sessions, 1);
	const jobs = await json(await fetch(`${base}/api/memory/observatory/jobs`, { headers }));
	assert.equal(jobs.data.items[0].jobKey, "memory-session");
	assert.doesNotMatch(JSON.stringify(jobs), /payload|ownership_token/);
	const phase1 = await json(await fetch(`${base}/api/memory/observatory/phase1`, { headers }));
	assert.equal(phase1.data.items[0].rawMemoryBytes, 10);
	assert.doesNotMatch(JSON.stringify(phase1), /raw memory|rollout summary/);
	const content = await json(await fetch(`${base}/api/memory/observatory/phase1/memory-session/content?field=rolloutSummary`, { headers }));
	assert.equal(content.data.content, "rollout summary");
	assert.equal((await fetch(`${base}/api/memory/observatory/phase1/memory-session/content?field=payload`, { headers })).status, 400);
}));

test("pi-web exposes fixed Memory Overview artifacts and directory metadata without path disclosure", () => withServer(async ({ root, base, headers }) => {
	const artifacts = await json(await fetch(`${base}/api/memory/observatory/artifacts`, { headers }));
	assert.deepEqual(artifacts.data.items.map((item) => item.id), ["memory-summary", "memory-handbook", "raw-memories", "rollout-summaries", "memory-skills"]);
	const directory = await json(await fetch(`${base}/api/memory/observatory/artifacts/memory-skills`, { headers }));
	assert.equal(directory.data.kind, "directory");
	assert.deepEqual(directory.data.entries.map((item) => item.name), ["demo/SKILL.md"]);
	assert.doesNotMatch(JSON.stringify(directory), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const child = directory.data.entries[0];
	const content = await json(await fetch(`${base}/api/memory/observatory/artifacts/${child.id}/content?maxBytes=6`, { headers }));
	assert.equal(content.data.content, "memory");
	assert.equal(content.data.truncated, true);
	assert.equal((await fetch(`${base}/api/memory/observatory/artifacts/unknown`, { headers })).status, 404);
	assert.equal((await fetch(`${base}/api/memory/observatory/artifacts/unknown/content`, { headers })).status, 404);
}));

test("pi-web legacy memory documents remain GET-only and reject PUT", () => withServer(async ({ root, base, headers }) => {
	const summary = await json(await fetch(`${base}/api/memory/summary`, { headers }));
	assert.equal(summary.content, "v1\n\n# Summary\n");
	const put = await fetch(`${base}/api/memory/summary`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ content: "v1\n# changed\n", revision: summary.revision }) });
	assert.equal(put.status, 405);
	assert.equal(readFileSync(join(root, "agent", "memories", "memory_summary.md"), "utf8"), "v1\n\n# Summary\n");
	assert.equal((await fetch(`${base}/api/memory/unknown`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).status, 404);
	const outside = join(root, "outside.md");
	writeFileSync(outside, "SECRET_OUTSIDE");
	rmSync(join(root, "agent", "memories", "MEMORY.md"));
	symlinkSync(outside, join(root, "agent", "memories", "MEMORY.md"));
	const escaped = await fetch(`${base}/api/memory/handbook`, { headers });
	assert.equal(escaped.status, 403);
	assert.doesNotMatch(await escaped.text(), /SECRET_OUTSIDE/);
}));
