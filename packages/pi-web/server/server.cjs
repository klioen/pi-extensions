"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const core = require("../lib/pi-web-core.cjs");
const chatCore = require("../lib/chat-core.cjs");
const diskUsageCore = require("../lib/disk-usage-core.cjs");
const observatoryCore = require("../lib/memory-observatory-core.cjs");

const JSON_LIMIT = 1024 * 1024;
const DOCUMENT_LIMIT = 5 * 1024 * 1024;
const SESSION_LIMIT = 16 * 1024 * 1024;
const LOG_LIMIT = 200;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_CLIENT_LIMIT = 32;
const CHAT_HISTORY_ENTRIES = 2000;
const SESSION_HEADER_LIMIT = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(res, status, body, headers = {}) {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store", ...headers });
	res.end(data);
}

function errorStatus(error) {
	if (error instanceof URIError) return 400;
	if (error?.code === "MESSAGE_TOO_LARGE") return 413;
	if (error?.code === "CHAT_QUEUE_FULL") return 429;
	if (["CHAT_UNAVAILABLE", "CHAT_HISTORY_UNAVAILABLE", "SSE_CLIENT_LIMIT"].includes(error?.code)) return 503;
	if (["INVALID_REVISION", "INVALID_SKILL", "INVALID_MEMORY", "INVALID_JSON", "INVALID_SESSION_NAME", "BODY_TOO_LARGE", "INVALID_FIELD", "INVALID_DISK_USAGE_QUERY", "INVALID_CHAT_MESSAGE", "INVALID_EVENT_CURSOR"].includes(error?.code)) return 400;
	if (["REVISION_CONFLICT", "RESOURCE_LOCKED", "RESOURCE_EXISTS", "CURRENT_SESSION", "SESSION_CHANGED", "RUN_CHANGED"].includes(error?.code)) return 409;
	if (["READ_ONLY", "PATH_FORBIDDEN", "RESOURCE_TOO_LARGE"].includes(error?.code)) return 403;
	if (["ENOENT", "ARTIFACT_NOT_FOUND"].includes(error?.code)) return 404;
	return 500;
}

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > JSON_LIMIT) throw Object.assign(new Error("Request body is too large"), { code: "BODY_TOO_LARGE" });
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
	catch { throw Object.assign(new Error("Request body must be valid JSON"), { code: "INVALID_JSON" }); }
}

function safeReadBounded(file, fallback = "") {
	try { return core.readTextBounded(file, DOCUMENT_LIMIT); } catch (error) { if (error.code === "ENOENT") return { text: fallback, bytes: Buffer.byteLength(fallback), truncated: false }; throw error; }
}

function urlHost(host) {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function loopbackAuthorities(port) {
	return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function isAllowedLoopbackHost(value, port) {
	return typeof value === "string" && loopbackAuthorities(port).has(value.toLowerCase());
}

function isAllowedLoopbackOrigin(value, port) {
	if (typeof value !== "string") return false;
	const allowed = loopbackAuthorities(port);
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash && allowed.has(parsed.host.toLowerCase());
	} catch { return false; }
}

function tailLines(file, count = 50) {
	return core.readTailLinesBounded(file, Math.min(LOG_LIMIT, Math.max(1, count)));
}

function contentType(file) {
	return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream";
}

function observatoryEnvelope(observatory, data, warnings = []) {
	return { data, meta: { generatedAt: Date.now(), source: "memory.db", dbAvailable: Boolean(observatory.availability?.available), capabilities: observatory.capabilities?.features ?? {}, warnings } };
}

function observatoryOptions(requestUrl) {
	return {
		limit: Number(requestUrl.searchParams.get("limit")) || undefined,
		offset: Number(requestUrl.searchParams.get("offset")) || undefined,
		q: requestUrl.searchParams.get("q") || undefined,
		kind: requestUrl.searchParams.get("kind") || undefined,
		status: requestUrl.searchParams.get("status") || undefined,
		lines: Number(requestUrl.searchParams.get("lines")) || undefined,
		maxBytes: Number(requestUrl.searchParams.get("maxBytes")) || undefined,
	};
}

function createCatalog(options) {
	const agentDir = path.resolve(options.agentDir || path.join(os.homedir(), ".pi", "agent"));
	const cwd = path.resolve(options.cwd || process.cwd());
	const memoryDir = path.resolve(options.memoryDir || process.env.PI_MEMORY_DIR || path.join(agentDir, "memories"));
	const memoryDbPath = path.resolve(options.memoryDbPath || process.env.PI_MEMORY_DB || path.join(agentDir, "sqlite", "memory.db"));
	const projectTrusted = options.projectTrusted !== false;
	const projectRoots = projectTrusted ? [
		{ path: path.join(cwd, ".pi", "skills"), scope: "project", mutable: true },
		{ path: path.join(cwd, ".agents", "skills"), scope: "project-agents", mutable: true },
	] : [];
	const skillRoots = [
		{ path: path.join(agentDir, "skills"), scope: "user", mutable: true },
		{ path: path.join(memoryDir, "skills"), scope: "memory", mutable: false },
		...projectRoots,
	];
	const extensionRoots = [
		{ path: path.join(agentDir, "extensions"), scope: "user" },
		...(projectTrusted ? [{ path: path.join(cwd, ".pi", "extensions"), scope: "project" }] : []),
	];
	const settings = () => core.catalogSettings(path.join(agentDir, "settings.json"), projectTrusted ? path.join(cwd, ".pi", "settings.json") : undefined);
	const skills = () => options.listEffectiveSkills ? core.catalogEffectiveSkills(options.listEffectiveSkills(), skillRoots) : core.catalogSkills(skillRoots);
	const extensions = () => ({ ...core.catalogExtensions(extensionRoots), settings: settings() });
	return { agentDir, cwd, memoryDir, memoryDbPath, projectTrusted, skillRoots, extensionRoots, settings, skills, extensions };
}

function findSkill(catalog, id, requireMutable = false) {
	const item = catalog.skills().skills.find((skill) => skill.id === id);
	if (!item) throw Object.assign(new Error("Skill not found"), { code: "ENOENT" });
	if (!core.isPathContained(path.dirname(item.path), item.path)) throw Object.assign(new Error("Skill path is unavailable"), { code: "PATH_FORBIDDEN" });
	if (!requireMutable) return item;
	if (!item.mutable) throw Object.assign(new Error("This skill source is read-only"), { code: "READ_ONLY" });
	const root = catalog.skillRoots.find((candidate) => candidate.mutable && candidate.scope === item.scope && core.isPathContained(candidate.path, item.path));
	if (!root) throw Object.assign(new Error("Skill path is outside an allowed writable root"), { code: "PATH_FORBIDDEN" });
	return item;
}

function chatError(code, message) {
	return Object.assign(new Error(message), { code });
}

function publicChatSnapshot(snapshot, eventCursor) {
	const source = snapshot && typeof snapshot === "object" ? snapshot : {};
	const run = source.activeRun && typeof source.activeRun === "object" ? source.activeRun : undefined;
	const capabilities = source.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
	return {
		available: source.available === true,
		currentSessionId: typeof source.currentSessionId === "string" ? source.currentSessionId : undefined,
		sessionName: typeof source.sessionName === "string" ? source.sessionName : undefined,
		cwd: typeof source.cwd === "string" ? source.cwd : undefined,
		idle: source.idle === true,
		hasPendingMessages: source.hasPendingMessages === true,
		activeRun: run && UUID_RE.test(run.runId) ? {
			runId: run.runId,
			...(typeof run.state === "string" ? { state: run.state } : {}),
			...(typeof run.requestId === "string" && UUID_RE.test(run.requestId) ? { requestId: run.requestId } : {}),
		} : null,
		eventCursor,
		capabilities: Object.fromEntries(["send", "followUp", "abort", "steer", "createSession", "switchSession"].map((key) => [key, capabilities[key] === true])),
	};
}

function sseFrame(event) {
	return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readSessionDocumentTail(file) {
	const size = fs.statSync(file).size;
	if (size <= SESSION_LIMIT) return { text: fs.readFileSync(file, "utf8"), truncated: false };
	const descriptor = fs.openSync(file, "r");
	try {
		const headerBuffer = Buffer.allocUnsafe(Math.min(size, SESSION_HEADER_LIMIT));
		const headerBytes = fs.readSync(descriptor, headerBuffer, 0, headerBuffer.length, 0);
		const headerText = headerBuffer.subarray(0, headerBytes).toString("utf8");
		const headerEnd = headerText.indexOf("\n");
		const header = headerEnd < 0 ? headerText : headerText.slice(0, headerEnd);
		const tailBuffer = Buffer.allocUnsafe(SESSION_LIMIT);
		const tailBytes = fs.readSync(descriptor, tailBuffer, 0, SESSION_LIMIT, size - SESSION_LIMIT);
		let tail = tailBuffer.subarray(0, tailBytes).toString("utf8");
		const firstLineEnd = tail.indexOf("\n");
		tail = firstLineEnd < 0 ? "" : tail.slice(firstLineEnd + 1);
		return { text: `${header}\n${tail}`, truncated: true };
	} finally {
		fs.closeSync(descriptor);
	}
}

function parseRecentSessionRecords(text, maxEntries = CHAT_HISTORY_ENTRIES) {
	let header;
	const records = [];
	let omitted = false;
	for (const line of String(text).split(/\r?\n/)) {
		if (!line.trim()) continue;
		let value;
		try { value = JSON.parse(line); } catch { continue; }
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (!header && (value.type === "session" || value.type === "session_meta")) {
			header = value;
			continue;
		}
		if (records.length === maxEntries) {
			records.shift();
			omitted = true;
		}
		records.push(value);
	}
	return { header, records, omitted };
}

function memoryDocument(catalog, name) {
	const validation = core.validateMemoryDocument(name, name === "summary" ? "v1" : "");
	if (!validation.fileName) throw Object.assign(new Error("Memory document not found"), { code: "ENOENT" });
	if (!fs.existsSync(catalog.memoryDir)) fs.mkdirSync(catalog.memoryDir, { recursive: true });
	const file = path.join(catalog.memoryDir, validation.fileName);
	if (!core.isPathContained(catalog.memoryDir, file)) throw Object.assign(new Error("Memory document path is outside the allowed root"), { code: "PATH_FORBIDDEN" });
	return file;
}

function createPiWebServer(options = {}) {
	const host = options.host || "127.0.0.1";
	if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Pi Web only supports loopback hosts");
	const port = Number.isInteger(options.port) ? options.port : 8787;
	const publicDir = path.resolve(options.publicDir || path.join(__dirname, "..", "public"));
	const catalog = createCatalog(options);
	const diskUsage = diskUsageCore.createDiskUsageService({
		rootDir: options.piRootDir || path.join(os.homedir(), ".pi"),
		ttlMs: options.diskUsageTtlMs,
		concurrency: options.diskUsageConcurrency,
		maxEntries: options.diskUsageMaxEntries,
		maxDepth: options.diskUsageMaxDepth,
	});
	const chatAdapter = options.chatAdapter;
	const eventHub = options.eventHub || chatCore.createChatEventHub();
	const requestCache = chatCore.createRequestIdempotencyCache();
	const pendingRequests = new Map();
	const sseClients = new Set();
	const sseHeartbeatMs = Number.isSafeInteger(options.sseHeartbeatMs) && options.sseHeartbeatMs > 0 ? options.sseHeartbeatMs : SSE_HEARTBEAT_MS;
	const maxSseClients = Number.isSafeInteger(options.maxSseClients) && options.maxSseClients > 0 ? options.maxSseClients : SSE_CLIENT_LIMIT;
	let unsubscribeAdapter;
	let server;
	if (!options.eventHub && typeof chatAdapter?.subscribe === "function") {
		unsubscribeAdapter = chatAdapter.subscribe((event) => eventHub.publish(event));
	}

	function chatSnapshot() {
		if (!chatAdapter || typeof chatAdapter.getSnapshot !== "function") throw chatError("CHAT_UNAVAILABLE", "Chat runtime is unavailable");
		return publicChatSnapshot(chatAdapter.getSnapshot(), eventHub.cursor);
	}

	function requireAvailableSnapshot() {
		const snapshot = chatSnapshot();
		if (!snapshot.available || !snapshot.currentSessionId) throw chatError("CHAT_UNAVAILABLE", "Chat runtime is unavailable");
		return snapshot;
	}

	function closeSseClient(client) {
		if (!sseClients.delete(client)) return;
		clearInterval(client.heartbeat);
		client.unsubscribe();
		if (!client.res.writableEnded) client.res.end();
	}

	function writeSse(client, value) {
		if (client.res.writableEnded || client.res.destroyed) return closeSseClient(client);
		if (!client.res.write(value)) closeSseClient(client);
	}

	async function listSessionRecords(query = "") {
		const sessions = await (options.listSessions ? options.listSessions() : []);
		return core.summarizeSessions(sessions.map((session) => ({
			id: session.id, name: session.name, cwd: session.cwd, path: session.path,
			created: session.created instanceof Date ? session.created.toISOString() : session.created,
			modified: session.modified instanceof Date ? session.modified.toISOString() : session.modified,
			messageCount: session.messageCount, firstMessage: session.firstMessage, allMessagesText: session.allMessagesText,
		})), query);
	}

	function publicSession(session) {
		const { path: _path, file: _file, allMessagesText: _searchText, ...safe } = session;
		const cwd = typeof session.cwd === "string" ? session.cwd : "";
		return { ...safe, projectId: core.sha256Revision(`session-project\0${cwd}`), current: session.id === options.getCurrentSessionId?.() };
	}

	async function listSessions(query = "") {
		return (await listSessionRecords(query)).map(publicSession);
	}

	async function findSession(id) {
		return (await listSessionRecords()).find((session) => session.id === id);
	}

	function deleteSessionFile(sessionPath) {
		const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
		const trashed = spawnSync("trash", args, { encoding: "utf8", stdio: "ignore" });
		if (trashed.status === 0 || !fs.existsSync(sessionPath)) return { method: "trash" };
		fs.unlinkSync(sessionPath);
		return { method: "unlink" };
	}

	async function handler(req, res) {
		const requestUrl = new URL(req.url || "/", `http://${urlHost(host)}:${port}`);
		try {
			if (requestUrl.pathname.startsWith("/api/")) {
				const address = server?.address();
				const boundPort = address && typeof address !== "string" ? address.port : undefined;
				if (!boundPort || !isAllowedLoopbackHost(req.headers.host, boundPort)) return json(res, 403, { error: "Host is not allowed" });
				if (!["GET", "HEAD"].includes(req.method || "GET")) {
					if (!isAllowedLoopbackOrigin(req.headers.origin, boundPort)) return json(res, 403, { error: "Origin is not allowed" });
				}
				if (requestUrl.pathname === "/api/chat/snapshot" && req.method === "GET") {
					return json(res, 200, chatSnapshot());
				}
				if (requestUrl.pathname === "/api/chat/history" && req.method === "GET") {
					const snapshot = requireAvailableSnapshot();
					if (typeof chatAdapter.getCurrentSessionRecord !== "function") throw chatError("CHAT_UNAVAILABLE", "Chat history is unavailable");
					const record = await chatAdapter.getCurrentSessionRecord();
					if (!record || record.id !== snapshot.currentSessionId || typeof record.path !== "string") throw chatError("SESSION_CHANGED", "Current session changed");
					let document;
					try { document = readSessionDocumentTail(record.path); }
					catch { throw chatError("CHAT_HISTORY_UNAVAILABLE", "Chat history is unavailable"); }
					const recent = parseRecentSessionRecords(document.text);
					const sessionId = recent.header?.id ?? recent.header?.sessionId ?? recent.header?.payload?.id;
					if (sessionId && sessionId !== snapshot.currentSessionId) throw chatError("SESSION_CHANGED", "Current session changed");
					const activeBranch = core.selectActiveSessionBranch(recent.records);
					const history = core.normalizeSessionChatHistory(activeBranch, { maxEntries: CHAT_HISTORY_ENTRIES });
					return json(res, 200, {
						sessionId: snapshot.currentSessionId,
						revision: document.truncated ? undefined : core.sha256Revision(document.text),
						truncated: document.truncated || recent.omitted || history.metadata.truncated || history.metadata.contentTruncated,
						entries: history.entries,
					});
				}
				if (requestUrl.pathname === "/api/chat/messages" && req.method === "POST") {
					const body = chatCore.validateChatMessageInput(await readJson(req));
					const snapshot = requireAvailableSnapshot();
					if (body.sessionId !== snapshot.currentSessionId) throw chatError("SESSION_CHANGED", "Current session changed");
					const cached = requestCache.get(body.requestId);
					if (cached) return json(res, 202, cached);
					if (pendingRequests.has(body.requestId)) return json(res, 202, await pendingRequests.get(body.requestId));
					if (typeof chatAdapter.sendUserMessage !== "function") throw chatError("CHAT_UNAVAILABLE", "Sending chat messages is unavailable");
					const operation = Promise.resolve(chatAdapter.sendUserMessage({ requestId: body.requestId, text: body.text })).then((acceptance) => {
						const result = {
							accepted: true,
							requestId: body.requestId,
							delivery: acceptance?.delivery === "followUp" ? "followUp" : "immediate",
						};
						requestCache.set(body.requestId, result);
						return result;
					});
					pendingRequests.set(body.requestId, operation);
					try { return json(res, 202, await operation); }
					finally { pendingRequests.delete(body.requestId); }
				}
				if (requestUrl.pathname === "/api/chat/abort" && req.method === "POST") {
					const body = await readJson(req);
					if (!UUID_RE.test(body.sessionId) || !UUID_RE.test(body.runId)) throw chatError("INVALID_CHAT_MESSAGE", "sessionId and runId must be UUIDs");
					const snapshot = requireAvailableSnapshot();
					if (body.sessionId !== snapshot.currentSessionId || body.runId !== snapshot.activeRun?.runId) throw chatError("RUN_CHANGED", "Current run changed");
					if (typeof chatAdapter.abort !== "function") throw chatError("CHAT_UNAVAILABLE", "Chat abort is unavailable");
					await chatAdapter.abort({ sessionId: body.sessionId, runId: body.runId });
					return json(res, 202, { accepted: true, sessionId: body.sessionId, runId: body.runId });
				}
				if (requestUrl.pathname === "/api/chat/events" && req.method === "GET") {
					const snapshot = requireAvailableSnapshot();
					const rawCursor = req.headers["last-event-id"] ?? requestUrl.searchParams.get("lastEventId") ?? "0";
					if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) throw chatError("INVALID_EVENT_CURSOR", "Last-Event-ID must be a non-negative integer");
					if (sseClients.size >= maxSseClients) throw chatError("SSE_CLIENT_LIMIT", "Too many chat event clients");
					res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
					res.flushHeaders?.();
					const client = { res, heartbeat: undefined, unsubscribe: () => {}, replaying: true, pending: [] };
					client.unsubscribe = eventHub.subscribe((event) => {
						const controlEvent = event.type === "session.changed" || event.type === "stream.reset";
						if (!controlEvent && event.sessionId !== snapshot.currentSessionId) return;
						if (client.replaying) client.pending.push(event);
						else writeSse(client, sseFrame(event));
					});
					client.heartbeat = setInterval(() => writeSse(client, `: heartbeat ${Date.now()}\n\n`), sseHeartbeatMs);
					client.heartbeat.unref?.();
					sseClients.add(client);
					const close = () => closeSseClient(client);
					req.once("close", close);
					res.once("close", close);
					const replay = eventHub.replay(Number(rawCursor));
					let lastWrittenId = Number(rawCursor);
					if (replay.reset) {
						// The global hub cannot prove which session owned an evicted event.
						// Reset conservatively rather than risk silently losing current-session data.
						writeSse(client, sseFrame({ id: replay.cursor, type: "stream.reset", timestamp: Date.now(), sessionId: snapshot.currentSessionId, data: { reason: replay.reason, cursor: replay.cursor } }));
						lastWrittenId = replay.cursor;
					} else {
						for (const event of replay.events) {
							const controlEvent = event.type === "session.changed" || event.type === "stream.reset";
							if (controlEvent || event.sessionId === snapshot.currentSessionId) {
								writeSse(client, sseFrame(event));
								lastWrittenId = Math.max(lastWrittenId, event.id);
							}
					}
					}
					client.replaying = false;
					for (const event of client.pending.sort((a, b) => a.id - b.id)) {
						if (event.id > lastWrittenId) {
							writeSse(client, sseFrame(event));
							lastWrittenId = event.id;
						}
					}
					client.pending.length = 0;
					return;
				}
				if (requestUrl.pathname === "/api/disk-usage" && req.method === "GET") {
					const sort = requestUrl.searchParams.get("sort") || "size";
					const order = requestUrl.searchParams.get("order") || "desc";
					const refreshValue = requestUrl.searchParams.get("refresh") || "0";
					if (!new Set(["size", "name", "modified", "type"]).has(sort)) throw Object.assign(new Error("Invalid disk usage sort"), { code: "INVALID_DISK_USAGE_QUERY" });
					if (!new Set(["asc", "desc"]).has(order)) throw Object.assign(new Error("Invalid disk usage order"), { code: "INVALID_DISK_USAGE_QUERY" });
					if (!new Set(["0", "1"]).has(refreshValue)) throw Object.assign(new Error("Invalid disk usage refresh"), { code: "INVALID_DISK_USAGE_QUERY" });
					return json(res, 200, await diskUsage.get(requestUrl.searchParams.get("path") || "", { sort, order, refresh: refreshValue === "1" }));
				}
				if (requestUrl.pathname === "/api/overview" && req.method === "GET") {
					const [sessions, skillResult] = await Promise.all([listSessions(), Promise.resolve(catalog.skills())]);
					const extensionResult = catalog.extensions();
					return json(res, 200, { cwd: catalog.cwd, projectTrusted: catalog.projectTrusted, recentSessions: sessions.slice(0, 6), counts: { sessions: sessions.length, skills: skillResult.skills.length, extensions: extensionResult.entries.length, packages: extensionResult.settings.packages.length }, memory: { summary: fs.existsSync(path.join(catalog.memoryDir, "memory_summary.md")), handbook: fs.existsSync(path.join(catalog.memoryDir, "MEMORY.md")) } });
				}
				if (requestUrl.pathname === "/api/sessions" && req.method === "GET") {
					const sessions = await listSessions(requestUrl.searchParams.get("q") || "");
					return json(res, 200, { sessions, tree: core.buildSessionTree(sessions) });
				}
				const sessionMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)$/);
				if (sessionMatch) {
					const id = decodeURIComponent(sessionMatch[1]);
					const item = await findSession(id);
					if (!item?.path) return json(res, 404, { error: "Session not found" });
					const current = item.id === options.getCurrentSessionId?.();
					if (req.method === "GET") {
						const sessionDocument = readSessionDocumentTail(item.path);
						const parsed = core.parseSessionJsonl(sessionDocument.text, { maxEntries: 2000, keepLatest: true });
						const activeBranch = core.selectActiveSessionBranch(parsed.entries);
						const history = core.normalizeSessionChatHistory(activeBranch, { maxEntries: 2000 });
						return json(res, 200, {
							session: publicSession(item),
							current,
							sourceTruncated: sessionDocument.truncated,
							revision: sessionDocument.truncated ? undefined : core.sha256Revision(sessionDocument.text),
							summary: parsed.summary,
							diagnostics: parsed.diagnostics,
							chatHistory: history.entries,
							chatHistoryMetadata: history.metadata,
						});
					}
					if (req.method === "PATCH") {
						const body = await readJson(req);
						const result = core.renameSessionWithRevision(item.path, body.name, body.revision, (name) => {
							if (!options.renameSession) throw Object.assign(new Error("Session rename is unavailable"), { code: "READ_ONLY" });
							const returned = options.renameSession(item, name, current);
							if (returned && typeof returned.then === "function") throw new Error("Session rename callback must be synchronous");
						});
						return json(res, 200, { ...result, current });
					}
					if (req.method === "DELETE") {
						if (current) throw Object.assign(new Error("The current session cannot be deleted"), { code: "CURRENT_SESSION" });
						const body = await readJson(req);
						const result = core.removeSessionWithRevision(item.path, body.revision, () => {
							const returned = options.deleteSession ? options.deleteSession(item) : deleteSessionFile(item.path);
							if (returned && typeof returned.then === "function") throw new Error("Session delete callback must be synchronous");
							return returned;
						});
						return json(res, 200, result);
					}
				}
				if (requestUrl.pathname === "/api/skills" && req.method === "GET") return json(res, 200, catalog.skills());
				if (requestUrl.pathname === "/api/skills" && req.method === "POST") {
					const body = await readJson(req);
					const document = core.serializeSkillDocument(body);
					const root = catalog.skillRoots.find((item) => item.scope === (body.scope || "user") && item.mutable);
					if (!root) return json(res, 400, { error: "Invalid writable skill scope" });
					fs.mkdirSync(root.path, { recursive: true });
					const skillDir = core.resolveContainedPath(root.path, body.name);
					const file = path.join(skillDir, "SKILL.md");
					if (fs.existsSync(file)) return json(res, 409, { error: "Skill already exists" });
					const result = core.createFileExclusive(file, document);
					return json(res, 201, result);
				}
				const skillMatch = requestUrl.pathname.match(/^\/api\/skills\/([^/]+)$/);
				if (skillMatch) {
					const id = decodeURIComponent(skillMatch[1]);
					if (req.method === "GET") { const item = findSkill(catalog, id); return json(res, 200, { skill: item, content: core.readTextBounded(item.path, DOCUMENT_LIMIT).text }); }
					const item = findSkill(catalog, id, true);
					if (req.method === "PUT") {
						const body = await readJson(req); const validation = core.validateSkillDocument(body.content);
						if (!validation.valid) return json(res, 400, { error: "Invalid skill", diagnostics: validation });
						return json(res, 200, core.writeFileWithRevision(item.path, body.content, body.revision));
					}
					if (req.method === "DELETE") {
						const body = await readJson(req); core.deleteFileWithRevision(item.path, body.revision);
						const skillDirectory = path.dirname(item.path);
						const root = catalog.skillRoots.find((candidate) => candidate.scope === item.scope && core.isPathContained(candidate.path, item.path));
						if (root && path.resolve(skillDirectory) !== path.resolve(root.path) && fs.readdirSync(skillDirectory).length === 0) fs.rmdirSync(skillDirectory);
						return json(res, 200, { deleted: true });
					}
				}
				if (requestUrl.pathname === "/api/extensions" && req.method === "GET") {
					const result = catalog.extensions();
					return json(res, 200, { entries: result.entries, diagnostics: result.diagnostics, settings: { packages: result.settings.packages, extensionPaths: result.settings.extensionPaths, diagnostics: result.settings.diagnostics } });
				}
				if (requestUrl.pathname.startsWith("/api/memory/observatory/") && req.method === "GET") {
					const observatory = observatoryCore.openMemoryObservatory({ dbPath: catalog.memoryDbPath, memoryDir: catalog.memoryDir });
					try {
						const suffix = requestUrl.pathname.slice("/api/memory/observatory/".length);
						const options = observatoryOptions(requestUrl);
						let data;
						if (suffix === "overview") data = observatoryCore.queryOverview(observatory, options);
						else if (suffix === "workers") data = observatoryCore.queryWorkers(observatory, options);
						else if (suffix === "jobs") data = observatoryCore.queryJobs(observatory, options);
						else if (suffix === "sessions") data = observatoryCore.querySessions(observatory, options);
						else if (suffix === "phase1") data = observatoryCore.queryPhase1(observatory, options);
						else if (suffix === "phase2") data = observatoryCore.queryPhase2(observatory, options);
						else if (suffix === "artifacts") data = observatoryCore.queryArtifacts(observatory, options);
						else if (suffix === "logs") { const result = observatoryCore.queryLogs(observatory, options); data = { ...result, items: result.lines.map((line, index) => ({ id: index, level: /error|fail/i.test(line) ? "error" : /warn/i.test(line) ? "warn" : "info", message: line })) }; }
						else {
							const phase1Content = suffix.match(/^phase1\/([^/]+)\/content$/);
							const phase1Detail = suffix.match(/^phase1\/([^/]+)$/);
							const artifactContent = suffix.match(/^artifacts\/([^/]+)\/content$/);
							const artifactDetail = suffix.match(/^artifacts\/([^/]+)$/);
							if (phase1Content) data = observatoryCore.queryPhase1Content(observatory, decodeURIComponent(phase1Content[1]), requestUrl.searchParams.get("field"), options);
							else if (phase1Detail) data = observatoryCore.queryPhase1Detail(observatory, decodeURIComponent(phase1Detail[1]));
							else if (artifactContent) data = observatoryCore.queryArtifactContent(observatory, decodeURIComponent(artifactContent[1]), options);
							else if (artifactDetail) data = observatoryCore.queryArtifactDetail(observatory, decodeURIComponent(artifactDetail[1]));
							else return json(res, 404, { error: "Observatory route not found" });
							if (data === null) return json(res, 404, { error: "Memory resource not found" });
						}
						return json(res, 200, observatoryEnvelope(observatory, data, observatory.availability?.reason ? [observatory.availability.reason] : []));
					} finally { observatory.close(); }
				}
				if (requestUrl.pathname === "/api/memory" && req.method === "GET") {
					const rolloutDir = path.join(catalog.memoryDir, "rollout_summaries");
					const rollouts = fs.existsSync(rolloutDir) && core.isPathContained(catalog.memoryDir, rolloutDir) ? fs.readdirSync(rolloutDir).filter((name) => name.endsWith(".md")).sort().reverse().slice(0, 100) : [];
					const logFile = path.join(catalog.memoryDir, "worker.log");
					const log = fs.existsSync(logFile) && !core.isPathContained(catalog.memoryDir, logFile) ? [] : tailLines(logFile, Number(requestUrl.searchParams.get("lines")) || 50).map(observatoryCore.sanitizeDiagnosticText);
					return json(res, 200, { documents: ["summary", "handbook"].map((name) => { const file = memoryDocument(catalog, name); const document = safeReadBounded(file); return { name, editable: !document.truncated, truncated: document.truncated, exists: fs.existsSync(file), revision: document.truncated ? undefined : core.sha256Revision(document.text), bytes: document.bytes };  }), rollouts, log });
				}
				const memoryMatch = requestUrl.pathname.match(/^\/api\/memory\/(summary|handbook)$/);
				if (memoryMatch) {
					const file = memoryDocument(catalog, memoryMatch[1]);
					if (req.method === "GET") { const document = safeReadBounded(file); return json(res, 200, { name: memoryMatch[1], editable: false, truncated: document.truncated, content: document.text, revision: document.truncated ? undefined : core.sha256Revision(document.text) }); }
					return json(res, 405, { error: "Memory documents are read-only" }, { allow: "GET" });
				}
				return json(res, 404, { error: "API route not found" });
			}

			const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
			let file;
			try { file = core.resolveContainedPath(publicDir, relative); } catch { return json(res, 404, { error: "Not found" }); }
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "Not found" });
			const data = fs.readFileSync(file);
			const immutableAsset = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(relative);
			res.writeHead(200, { "content-type": contentType(file), "content-length": data.length, "cache-control": immutableAsset ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" }); res.end(data);
		} catch (error) { json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error), code: error?.code }); }
	}

	return {
		host, requestedPort: port, catalog,
		async start() { if (server?.listening) return this.address(); server = http.createServer(handler); server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); return this.address(); },
		async stop() {
			for (const client of [...sseClients]) closeSseClient(client);
			unsubscribeAdapter?.();
			unsubscribeAdapter = undefined;
			requestCache.clear();
			pendingRequests.clear();
			if (!server) return;
			const current = server; server = undefined;
			const closed = new Promise((resolve) => current.close(() => resolve()));
			current.closeAllConnections?.();
			await closed;
		},
		address() { const address = server?.address(); if (!address || typeof address === "string") return undefined; return { host, port: address.port, url: `http://${urlHost(host)}:${address.port}/` }; },
		handler,
	};
}

module.exports = { createPiWebServer, createCatalog };
