import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createPiWebServer } from "../packages/pi-web/server/server.cjs";
import { createChatEventHub } from "../packages/pi-web/lib/chat-core.cjs";
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
	const resolvedServerOptions = typeof serverOptions === "function" ? serverOptions({ root, sessionPath, cwd }) : serverOptions;
	const server = createPiWebServer({ host: "127.0.0.1", port: 0, cwd, agentDir, memoryDir, memoryDbPath, piRootDir, publicDir, projectTrusted: true, listSessions: async () => [{ id: "s1", path: sessionPath, cwd, name: "Demo", created: new Date(0), modified: new Date(1), messageCount: 1, firstMessage: "hello" }], ...resolvedServerOptions });
	try { const address = await server.start(); await run({ root, base: `http://127.0.0.1:${address.port}`, headers: { origin: `http://127.0.0.1:${address.port}` } }); }
	finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
}

async function json(response) { return response.json(); }

function requestWithHost(base, pathname, { host, method = "GET", origin } = {}) {
	const target = new URL(pathname, base);
	return new Promise((resolve, reject) => {
		const req = httpRequest(target, { method, headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}) } }, (res) => {
			res.resume();
			res.once("end", () => resolve(res.statusCode));
		});
		req.once("error", reject);
		req.end();
	});
}

const sseReaderState = new WeakMap();

async function readSseFrame(reader, timeoutMs = 1000) {
	let state = sseReaderState.get(reader);
	if (!state) {
		state = { decoder: new TextDecoder(), buffered: "" };
		sseReaderState.set(reader, state);
	}
	for (;;) {
		const end = state.buffered.indexOf("\n\n");
		if (end >= 0) {
			const frame = state.buffered.slice(0, end + 2);
			state.buffered = state.buffered.slice(end + 2);
			return frame;
		}
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE frame")), timeoutMs));
		const { value, done } = await Promise.race([reader.read(), timeout]);
		if (done) return state.buffered;
		state.buffered += state.decoder.decode(value, { stream: true });
	}
}

function chatFixture(sessionPath, overrides = {}) {
	const sessionId = overrides.sessionId || randomUUID();
	const runId = overrides.runId || randomUUID();
	const sent = [];
	const aborted = [];
	let snapshot = {
		available: true,
		currentSessionId: sessionId,
		sessionName: "Current chat",
		cwd: "/not-returned-as-a-path",
		idle: true,
		hasPendingMessages: false,
		activeRun: null,
		eventCursor: 0,
		capabilities: { send: true, followUp: true, abort: true, steer: false, createSession: false, switchSession: false },
	};
	const adapter = {
		getSnapshot: () => snapshot,
		getCurrentSessionRecord: async () => ({ id: sessionId, path: sessionPath }),
		sendUserMessage: async (input) => {
			sent.push(input);
			return { accepted: true, requestId: input.requestId, delivery: snapshot.idle ? "immediate" : "followUp" };
		},
		abort: async (input) => { aborted.push(input); },
	};
	return { sessionId, runId, sent, aborted, adapter, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; } };
}

test("pi-web production bundle is a local Vite React application", () => {
	const html = readFileSync(new URL("../packages/pi-web/public/index.html", import.meta.url), "utf8");
	assert.match(html, /<div id="root"><\/div>/);
	assert.match(html, /\.\/assets\/index-[A-Za-z0-9_-]+\.js/);
	assert.match(html, /\.\/assets\/index-[A-Za-z0-9_-]+\.css/);
	assert.doesNotMatch(html, /https?:\/\//);
	assert.doesNotMatch(html, /app\.js|chat-runtime\.js|chat-view\.js/);
});

test("pi-web extension routes current and historical session renames through Pi APIs", () => {
	const extension = readFileSync(new URL("../packages/pi-web/extensions/pi-web.ts", import.meta.url), "utf8");
	assert.match(extension, /listEffectiveSkills: \(\) => pi\.getCommands\(\)\.filter\(\(command\) => command\.source === "skill"\)/);
	assert.match(extension, /getCurrentSessionId: \(\) => currentSessionId/);
	assert.match(extension, /if \(current\) pi\.setSessionName\(name\)/);
	assert.match(extension, /SessionManager\.open\(session\.path\)\.appendSessionInfo\(name\)/);
});

test("pi-web React source owns route and memory UI behavior", () => {
	const router = readFileSync(new URL("../packages/pi-web/src/app/router.tsx", import.meta.url), "utf8");
	const memory = readFileSync(new URL("../packages/pi-web/src/pages/MemoryPage.tsx", import.meta.url), "utf8");
	assert.match(router, /createHashRouter/);
	assert.match(router, /path: "memory\/\*"/);
	assert.match(memory, /\/api\/memory\/observatory\/overview/);
	assert.match(memory, /\/api\/memory\/observatory\/workers/);
	assert.match(memory, /\/api\/memory\/observatory\/artifacts/);
});

test("pi-web accepts equivalent loopback Host and Origin values on the bound port", () => withServer(async ({ base }) => {
	const port = new URL(base).port;
	for (const authority of [`localhost:${port}`, `[::1]:${port}`]) {
		assert.equal(await requestWithHost(base, "/api/overview", { host: authority }), 200, authority);
		assert.equal(await requestWithHost(base, "/api/not-found", { method: "POST", host: authority, origin: `http://${authority}` }), 404, authority);
	}
	assert.equal(await requestWithHost(base, "/api/overview", { host: `evil.test:${port}` }), 403);
	assert.equal(await requestWithHost(base, "/api/not-found", { method: "POST", host: `localhost:${port}`, origin: `http://evil.test:${port}` }), 403);
	assert.equal(await requestWithHost(base, "/api/not-found", { method: "POST", host: `localhost:${Number(port) + 1}`, origin: `http://localhost:${Number(port) + 1}` }), 403);
}));

test("pi-web serves tokenless loopback APIs and caches only hashed Vite assets immutably", () => withServer(async ({ root, base, headers }) => {
	const assets = join(root, "public", "assets");
	mkdirSync(assets);
	writeFileSync(join(assets, "index-Ab12_cd3.js"), "export default true;");
	writeFileSync(join(assets, "runtime.js"), "export default false;");
	const overview = await fetch(`${base}/api/overview`);
	assert.equal(overview.status, 200);
	assert.deepEqual((await json(overview)).counts, { sessions: 1, skills: 2, extensions: 1, packages: 2 });
	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Pi Web/);
	assert.equal(page.headers.get("cache-control"), "no-cache");
	assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
	const hashedAsset = await fetch(`${base}/assets/index-Ab12_cd3.js`);
	assert.equal(hashedAsset.status, 200);
	assert.equal(hashedAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
	assert.equal((await fetch(`${base}/assets/runtime.js`)).headers.get("cache-control"), "no-cache");
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
	assert.match(sessions.sessions[0].projectId, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(sessions.sessions[0].projectId, /project|Users/);
	assert.doesNotMatch(JSON.stringify(sessions), /"(?:path|file)":|session\.jsonl/);
	const treeSessions = (nodes) => nodes.flatMap((node) => [...node.sessions, ...treeSessions(node.children)]);
	assert.deepEqual(treeSessions(sessions.tree).map((item) => item.id), ["s1"]);
	const detail = await json(await fetch(`${base}/api/sessions/s1`, { headers }));
	assert.equal(detail.summary.sessionId, "s1");
	assert.match(detail.revision, /^[a-f0-9]{64}$/);
	assert.ok(Array.isArray(detail.chatHistory));
	assert.doesNotMatch(JSON.stringify(detail), /credential|"details":|"(?:path|file)":|session\.jsonl|thinkingSignature/);
	const extensions = await json(await fetch(`${base}/api/extensions`, { headers }));
	assert.equal(extensions.entries.length, 1);
	assert.equal(extensions.settings.packages[0].source, "npm:demo");
	assert.doesNotMatch(JSON.stringify(extensions), /SECRET_SENTINEL|NESTED_SECRET/);
	assert.deepEqual(extensions.settings.packages[1].skills, ["skills/**"]);
}));

test("pi-web historical session detail retains the latest 2000 records", () => withServer(async ({ root, base, headers }) => {
	const sessionPath = join(root, "historical-long.jsonl");
	const records = [{ type: "session", id: "long-session", cwd: root }];
	for (let index = 0; index < 2105; index++) records.push({ type: "message", id: `m${index}`, message: { role: "user", content: `message-${index}` } });
	writeFileSync(sessionPath, `${records.map(JSON.stringify).join("\n")}\n`);
	const detail = await json(await fetch(`${base}/api/sessions/long-session`, { headers }));
	assert.equal(detail.chatHistory.length, 2000);
	assert.equal(detail.chatHistory[0].id, "m105");
	assert.equal(detail.chatHistory.at(-1).id, "m2104");
	assert.equal(detail.summary.truncated, true);
}, ({ root }) => ({
	listSessions: async () => [{ id: "long-session", path: join(root, "historical-long.jsonl"), cwd: root, name: "Long" }],
})));

test("pi-web historical session detail reads the latest records from files over 16 MiB", () => withServer(async ({ root, base, headers }) => {
	const sessionPath = join(root, "historical-oversized.jsonl");
	const header = { type: "session", id: "oversized-session", cwd: root };
	const padding = { type: "custom", id: "padding", parentId: null, data: "x".repeat(16 * 1024 * 1024) };
	const latest = { type: "message", id: "latest", parentId: "padding", message: { role: "assistant", content: "latest tail message" } };
	writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(padding)}\n${JSON.stringify(latest)}\n`);
	const detail = await json(await fetch(`${base}/api/sessions/oversized-session`, { headers }));
	assert.equal(detail.sourceTruncated, true);
	assert.equal(detail.revision, undefined);
	assert.deepEqual(detail.chatHistory.map((entry) => entry.id), ["latest"]);
	assert.equal(detail.chatHistory[0].content[0].text, "latest tail message");
}, ({ root }) => ({
	listSessions: async () => [{ id: "oversized-session", path: join(root, "historical-oversized.jsonl"), cwd: root, name: "Oversized" }],
})));

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

test("pi-web chat snapshot and bounded current history use only the injected current record", () => {
	let chat;
	return withServer(async ({ root, base, headers }) => {
	const sessionPath = join(root, "chat-current.jsonl");
	writeFileSync(sessionPath, [
		{ type: "session", id: chat.sessionId, cwd: root },
		{ type: "message", id: "u1", message: { role: "user", content: "hello", thinking: "USER_METADATA_MUST_STAY_HIDDEN" } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Inspect /Users/alice/private token=sk-abcdefghijklmnop", thinkingSignature: "SIGNED_SECRET", details: { token: "NOPE" } }, { type: "text", text: "hi" }] } },
	].map(JSON.stringify).join("\n"));
	const snapshotResponse = await fetch(`${base}/api/chat/snapshot`, { headers });
	assert.equal(snapshotResponse.status, 200);
	const snapshot = await json(snapshotResponse);
	assert.equal(snapshot.currentSessionId, chat.sessionId);
	assert.equal(snapshot.eventCursor, 0);
	assert.doesNotMatch(JSON.stringify(snapshot), /chat-current\.jsonl/);
	const historyResponse = await fetch(`${base}/api/chat/history`, { headers });
	assert.equal(historyResponse.status, 200);
	const history = await json(historyResponse);
	assert.equal(history.sessionId, chat.sessionId);
	assert.deepEqual(history.entries.map((entry) => entry.role), ["user", "assistant"]);
	assert.deepEqual(history.entries[1].content, [
		{ type: "thinking", text: "Inspect /Users/alice/private token=sk-abcdefghijklmnop" },
		{ type: "text", text: "hi" },
	]);
	assert.match(history.revision, /^[a-f0-9]{64}$/);
	assert.equal(history.truncated, false);
	assert.doesNotMatch(JSON.stringify(history), /USER_METADATA_MUST_STAY_HIDDEN|SIGNED_SECRET|NOPE|thinkingSignature|details|chat-current\.jsonl/);
	assert.match(JSON.stringify(history), /\/Users\/alice.*abcdefghijklmnop/);
	}, ({ root }) => {
		const sessionPath = join(root, "chat-current.jsonl");
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter };
	});
});

test("pi-web chat history returns a safe error when the current session file cannot be read", () => {
	let chat;
	return withServer(async ({ root, base, headers }) => {
		const response = await fetch(`${base}/api/chat/history`, { headers });
		assert.equal(response.status, 503);
		const body = await json(response);
		assert.deepEqual(body, { error: "Chat history is unavailable", code: "CHAT_HISTORY_UNAVAILABLE" });
		assert.doesNotMatch(JSON.stringify(body), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}, ({ root }) => {
		chat = chatFixture(join(root, "missing-private-session.jsonl"));
		return { chatAdapter: chat.adapter };
	});
});

test("pi-web chat history retains the latest 2000 records from long sessions", () => {
	let chat;
	return withServer(async ({ root, base, headers }) => {
		const sessionPath = join(root, "chat-long.jsonl");
		const records = [{ type: "session", id: chat.sessionId, cwd: root }];
		for (let index = 0; index < 2105; index++) records.push({ type: "message", id: `m${index}`, message: { role: "user", content: `message-${index}` } });
		writeFileSync(sessionPath, `${records.map(JSON.stringify).join("\n")}\n`);
		const response = await fetch(`${base}/api/chat/history`, { headers });
		assert.equal(response.status, 200);
		const history = await json(response);
		assert.equal(history.entries.length, 2000);
		assert.equal(history.entries[0].id, "m105");
		assert.equal(history.entries.at(-1).id, "m2104");
		assert.equal(history.truncated, true);
	}, ({ root }) => {
		chat = chatFixture(join(root, "chat-long.jsonl"));
		return { chatAdapter: chat.adapter };
	});
});

test("pi-web chat message validates input, current session, delivery, and request idempotency", () => {
	let chat;
	return withServer(async ({ root, base, headers }) => {
		const sessionPath = join(root, "chat.jsonl");
		writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: chat.sessionId })}\n`);
		const requestId = randomUUID();
		const send = (body) => fetch(`${base}/api/chat/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		const accepted = await send({ requestId, sessionId: chat.sessionId, text: " hello " });
		assert.equal(accepted.status, 202);
		assert.equal((await json(accepted)).delivery, "immediate");
		assert.deepEqual(chat.sent, [{ requestId, text: " hello " }]);
		assert.equal((await send({ requestId, sessionId: chat.sessionId, text: "changed duplicate" })).status, 202);
		assert.equal(chat.sent.length, 1);
		assert.equal((await send({ requestId: randomUUID(), sessionId: randomUUID(), text: "stale" })).status, 409);
		assert.equal((await send({ requestId: "bad", sessionId: chat.sessionId, text: "hello" })).status, 400);
		assert.equal((await send({ requestId: randomUUID(), sessionId: chat.sessionId, text: "   " })).status, 400);
		assert.equal((await send({ requestId: randomUUID(), sessionId: chat.sessionId, text: "x".repeat(64 * 1024 + 1) })).status, 413);
		const unavailable = { ...chat.snapshot, available: false };
		chat.snapshot = unavailable;
		assert.equal((await send({ requestId: randomUUID(), sessionId: chat.sessionId, text: "hello" })).status, 503);
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter };
	});
});

test("pi-web chat abort requires the current session and active run", () => {
	let chat;
	return withServer(async ({ root, base, headers }) => {
		const sessionPath = join(root, "chat.jsonl");
		chat.snapshot = { ...chat.snapshot, idle: false, activeRun: { runId: chat.runId, state: "running" } };
		const abort = (body) => fetch(`${base}/api/chat/abort`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await abort({ sessionId: chat.sessionId, runId: randomUUID() })).status, 409);
		const accepted = await abort({ sessionId: chat.sessionId, runId: chat.runId });
		assert.equal(accepted.status, 202);
		assert.deepEqual(chat.aborted, [{ sessionId: chat.sessionId, runId: chat.runId }]);
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter };
	});
});

test("pi-web chat SSE filters replay and live events to the snapshot session", () => {
	let chat;
	const eventHub = createChatEventHub({ maxEvents: 10 });
	return withServer(async ({ base, headers }) => {
		const otherSessionId = randomUUID();
		eventHub.publish({ type: "message.delta", sessionId: otherSessionId, data: { messageId: "foreign-replay", role: "assistant", delta: "secret" } });
		eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "current-replay", role: "assistant", delta: "safe" } });
		const response = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "0" } });
		assert.equal(response.status, 200);
		const reader = response.body.getReader();
		const replay = await readSseFrame(reader);
		assert.match(replay, /id: 2\nevent: message\.delta/);
		assert.match(replay, /current-replay/);
		assert.doesNotMatch(replay, /foreign-replay|secret|stream\.reset/);
		eventHub.publish({ type: "message.delta", sessionId: otherSessionId, data: { messageId: "foreign-live", role: "assistant", delta: "secret-live" } });
		eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "current-live", role: "assistant", delta: "safe-live" } });
		const live = await readSseFrame(reader);
		assert.match(live, /id: 4\nevent: message\.delta/);
		assert.match(live, /current-live/);
		assert.doesNotMatch(live, /foreign-live|secret-live|stream\.reset/);
		eventHub.publish({ type: "session.changed", sessionId: otherSessionId, data: { previousSessionId: chat.sessionId, currentSessionId: otherSessionId, available: true, reason: "new" } });
		const changed = await readSseFrame(reader);
		assert.match(changed, /event: session\.changed/);
		assert.match(changed, new RegExp(otherSessionId));
		await reader.cancel();
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter, eventHub };
	});
});

test("pi-web chat SSE stays ordered when subscribe publishes an event also visible to replay", () => {
	let chat;
	const baseHub = createChatEventHub({ maxEvents: 10 });
	let publishOnSubscribe;
	const eventHub = {
		get cursor() { return baseHub.cursor; },
		replay: (cursor) => baseHub.replay(cursor),
		publish: (event) => baseHub.publish(event),
		subscribe(listener) {
			const unsubscribe = baseHub.subscribe(listener);
			publishOnSubscribe?.();
			return unsubscribe;
		},
	};
	return withServer(async ({ base, headers }) => {
		eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "m1", role: "assistant", delta: "one" } });
		publishOnSubscribe = () => eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "m1", role: "assistant", delta: "two" } });
		const response = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "0" } });
		const reader = response.body.getReader();
		const first = await readSseFrame(reader);
		const second = await readSseFrame(reader);
		eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "m1", role: "assistant", delta: "three" } });
		const third = await readSseFrame(reader);
		assert.deepEqual([first, second, third].map((frame) => Number(frame.match(/^id: (\d+)/m)?.[1])), [1, 2, 3]);
		assert.deepEqual([first, second, third].map((frame) => JSON.parse(frame.match(/^data: (.+)$/m)?.[1]).data.delta), ["one", "two", "three"]);
		await reader.cancel();
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter, eventHub };
	});
});

test("pi-web chat SSE conservatively resets when an evicted replay gap cannot be attributed", () => {
	let chat;
	const eventHub = createChatEventHub({ maxEvents: 2 });
	return withServer(async ({ base, headers }) => {
		const otherSessionId = randomUUID();
		for (let index = 0; index < 3; index++) eventHub.publish({ type: "message.delta", sessionId: otherSessionId, data: { messageId: `foreign-${index}`, role: "assistant", delta: "secret" } });
		const response = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "0" } });
		const reader = response.body.getReader();
		const frame = await readSseFrame(reader);
		assert.match(frame, /event: stream\.reset/);
		assert.match(frame, /SSE_REPLAY_EXPIRED/);
		assert.doesNotMatch(frame, /foreign-|secret/);
		await reader.cancel();
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter, eventHub, sseHeartbeatMs: 10 };
	});
});

test("pi-web chat SSE replays, resets expired cursors for the current session, heartbeats, and unsubscribes", () => {
	let chat;
	const baseHub = createChatEventHub({ maxEvents: 2 });
	let subscribers = 0;
	const eventHub = {
		get cursor() { return baseHub.cursor; },
		replay: (cursor) => baseHub.replay(cursor),
		publish: (event) => baseHub.publish(event),
		subscribe(listener) { subscribers++; const unsubscribe = baseHub.subscribe(listener); return () => { subscribers--; unsubscribe(); }; },
	};
	return withServer(async ({ root, base, headers }) => {
		for (let index = 0; index < 3; index++) eventHub.publish({ type: "message.delta", sessionId: chat.sessionId, data: { messageId: "m1", role: "assistant", delta: String(index) } });
		const replayResponse = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "2" } });
		assert.equal(replayResponse.status, 200);
		assert.match(replayResponse.headers.get("content-type"), /text\/event-stream/);
		const replayReader = replayResponse.body.getReader();
		assert.match(await readSseFrame(replayReader), /id: 3\nevent: message\.delta\ndata:/);
		await replayReader.cancel();
		const resetResponse = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "0" } });
		const resetReader = resetResponse.body.getReader();
		const reset = await readSseFrame(resetReader);
		assert.match(reset, /event: stream\.reset/);
		assert.match(reset, /SSE_REPLAY_EXPIRED/);
		await resetReader.cancel();
		const liveResponse = await fetch(`${base}/api/chat/events`, { headers: { ...headers, "last-event-id": "3" } });
		const liveReader = liveResponse.body.getReader();
		assert.equal(subscribers, 1);
		assert.match(await readSseFrame(liveReader), /^: heartbeat/m);
		await liveReader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(subscribers, 0);
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter, eventHub, sseHeartbeatMs: 10 };
	});
});

test("pi-web chat SSE enforces a client limit with a stable error code", () => {
	let chat;
	return withServer(async ({ base, headers }) => {
		const first = await fetch(`${base}/api/chat/events`, { headers });
		assert.equal(first.status, 200);
		const rejected = await fetch(`${base}/api/chat/events`, { headers });
		assert.equal(rejected.status, 503);
		assert.deepEqual(await json(rejected), { error: "Too many chat event clients", code: "SSE_CLIENT_LIMIT" });
		await first.body.cancel();
	}, ({ sessionPath }) => {
		chat = chatFixture(sessionPath);
		return { chatAdapter: chat.adapter, maxSseClients: 1 };
	});
});

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
