/**
 * pi-memory: persistent memory backed by an OpenViking server.
 *
 * Faithful port of vikingbot's OpenViking integration
 * (bot/vikingbot/agent/tools/ov_file.py + agent/memory.py + agent/context.py):
 *
 * - Same tools: openviking_list / openviking_search / openviking_multi_read /
 *   openviking_grep / openviking_glob / openviking_add_resource /
 *   openviking_memory_commit.
 * - Same per-turn context injection: type-quota memory recall
 *   (events/entities/preferences) with three-level degradation
 *   (full → summary → uri) under a character budget, injected as
 *   `## openviking_search(query=[user_query])` plus the memory retrieval
 *   guidance block.
 * - Memory commit uses a dedicated `{session}__memory_commit__{ts}__{seq}`
 *   OpenViking session (never the chat session), polls the extraction task,
 *   and reports the memory diff URIs.
 *
 * Zero runtime dependencies: the OpenViking HTTP API client is implemented
 * with fetch, mirroring @openviking/sdk's transport (X-API-Key headers and
 * {result, error} envelope).
 *
 * Configuration (env):
 *   OPENVIKING_SERVER_URL   server base url (required; else extension no-ops)
 *   OPENVIKING_API_KEY      api key (required with url)
 *   OPENVIKING_ACCOUNT      optional account header
 *   OPENVIKING_USER         optional user header
 *   PI_MEMORY_PEER_ID       optional actor peer id — memory reads/writes are
 *                           routed to viking://~/peers/{peer}/memories/ and
 *                           commits use vikingbot's peer memory policy
 *   PI_MEMORY_EVENTS_LIMIT / PI_MEMORY_ENTITIES_LIMIT / PI_MEMORY_PREFERENCES_LIMIT
 *                           per-type recall quotas (default 10/10/3)
 *   PI_MEMORY_RECALL_MAX_CHARS  recall char budget (default 6500)
 *   PI_MEMORY_RECALL=0      disable auto recall injection
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config (env only)
// ---------------------------------------------------------------------------

const SERVER_URL = (process.env.OPENVIKING_SERVER_URL || process.env.PI_MEMORY_SERVER_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.OPENVIKING_API_KEY || process.env.PI_MEMORY_API_KEY || "";
const ACCOUNT = process.env.OPENVIKING_ACCOUNT || "";
const USER = process.env.OPENVIKING_USER || "";
const PEER_ID = (process.env.PI_MEMORY_PEER_ID || "").trim();

function intEnv(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const RECALL_ENABLED = process.env.PI_MEMORY_RECALL !== "0";
const TYPE_QUOTAS = {
	events: intEnv("PI_MEMORY_EVENTS_LIMIT", 10),
	entities: intEnv("PI_MEMORY_ENTITIES_LIMIT", 10),
	preferences: intEnv("PI_MEMORY_PREFERENCES_LIMIT", 3),
} as Record<string, number>;
const RECALL_MAX_CHARS = Math.max(1, intEnv("PI_MEMORY_RECALL_MAX_CHARS", 6500));
const RECALL_MIN_SCORE = 0.1;
const EVENT_CHAR_RATIO = 0.75;
const PREFERENCE_FULL_LIMIT = 1;

// Auto session sync (vikingbot openviking_hooks.py §7.5)
const AUTO_SYNC = process.env.PI_MEMORY_AUTO_SYNC !== "0";
const COMMIT_TOKEN_THRESHOLD = intEnv("PI_MEMORY_COMMIT_TOKENS", 200_000);
const MEMORY_WINDOW = intEnv("PI_MEMORY_MEMORY_WINDOW", 50);
const COMMIT_KEEP_RECENT = intEnv("PI_MEMORY_KEEP_RECENT", 10);
const SYNC_STATE_TYPE = "pi-memory-sync";

function available(): boolean {
	return Boolean(SERVER_URL && API_KEY);
}

/**
 * User scope base URI (e.g. "viking://user/default").
 *
 * From PI_MEMORY_USER_URI env; defaults to "viking://user/default".
 */
const USER_SCOPE = (process.env.PI_MEMORY_USER_URI || "").trim().replace(/\/+$/, "") || "viking://user/default";

function userScope(): string {
	return USER_SCOPE;
}

/** vikingbot's default memory policy for bot sessions (peer-first). */
function peerMemoryTarget(peer: string): string {
	return PEER_ID ? `viking://~/peers/${peer}/memories/` : `viking://~/memories/`;
}

function memoryPolicy(): Record<string, unknown> {
	return PEER_ID
		? { self: { enabled: false }, peer: { enabled: true } }
		: { self: { enabled: true }, peer: { enabled: false } };
}

// ---------------------------------------------------------------------------
// OpenViking HTTP client (mirrors @openviking/sdk transport + the endpoints
// vikingbot's VikingClient uses)
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

function normalizeUri(uri: string): string {
	return uri.startsWith("viking://") ? uri : `viking://${uri.replace(/^\/+/, "")}`;
}

class OVError extends Error {
	statusCode?: number;
	constructor(message: string, statusCode?: number) {
		super(message);
		this.statusCode = statusCode;
	}
}

class OVClient {
	readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl;
		this.headers = { "X-API-Key": apiKey };
		if (ACCOUNT) this.headers["X-OpenViking-Account"] = ACCOUNT;
		if (USER) this.headers["X-OpenViking-User"] = USER;
		if (PEER_ID) this.headers["X-OpenViking-Actor-Peer"] = PEER_ID;
	}

	private async request<T>(method: string, path: string, opts: { query?: Json; body?: unknown } = {}): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [k, v] of Object.entries(opts.query ?? {})) {
			if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
		}
		const init: RequestInit = { method, headers: { ...this.headers }, signal: AbortSignal.timeout(60_000) };
		if (opts.body !== undefined) {
			(init.headers as Record<string, string>)["Content-Type"] = "application/json";
			init.body = JSON.stringify(opts.body);
		}
		const response = await fetch(url, init);
		const text = await response.text();
		let envelope: { result?: unknown; error?: { message?: string; code?: string }; status?: string; detail?: unknown } = {};
		if (text) {
			try {
				envelope = JSON.parse(text);
			} catch {
				throw new OVError(`HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
			}
		}
		if (envelope.error || envelope.status === "error" || !response.ok) {
			throw new OVError(
				envelope.error?.message ?? String(envelope.detail ?? `HTTP ${response.status}`),
				response.status,
			);
		}
		return envelope.result as T;
	}

	// -- search ---------------------------------------------------------------
	/** Semantic retrieval grouped by memories/resources/skills. */
	find(query: string, opts: { targetUri?: string; limit?: number; contextType?: string } = {}): Promise<Json> {
		return this.request("POST", "/api/v1/search/find", {
			body: {
				query,
				target_uri: opts.targetUri,
				limit: opts.limit,
				...(opts.contextType ? { options: { context_type: opts.contextType } } : {}),
			},
		});
	}
	search(query: string, opts: { targetUri?: string; limit?: number } = {}): Promise<Json> {
		return this.request("POST", "/api/v1/search/search", {
			body: { query, target_uri: opts.targetUri, limit: opts.limit },
		});
	}
	grep(uri: string, pattern: string, opts: { caseInsensitive?: boolean; nodeLimit?: number } = {}): Promise<Json> {
		return this.request("POST", "/api/v1/search/grep", {
			body: {
				uri: normalizeUri(uri),
				pattern,
				case_insensitive: opts.caseInsensitive ?? false,
				node_limit: opts.nodeLimit ?? 256,
			},
		});
	}
	glob(pattern: string, uri = "viking://", opts: { nodeLimit?: number } = {}): Promise<Json> {
		return this.request("POST", "/api/v1/search/glob", {
			body: { pattern, uri: normalizeUri(uri), node_limit: opts.nodeLimit ?? 256 },
		});
	}

	// -- fs ---------------------------------------------------------------------
	ls(uri: string, opts: { recursive?: boolean; nodeLimit?: number } = {}): Promise<Json[]> {
		return this.request("GET", "/api/v1/fs/ls", {
			query: {
				uri: normalizeUri(uri),
				recursive: opts.recursive ?? false,
				node_limit: opts.nodeLimit ?? 1000,
			},
		});
	}
	stat(uri: string): Promise<Json> {
		return this.request("GET", "/api/v1/fs/stat", { query: { uri: normalizeUri(uri) } });
	}

	// -- content ----------------------------------------------------------------
	read(uri: string, offset = 0, limit = -1): Promise<string> {
		return this.request("GET", "/api/v1/content/read", {
			query: { uri: normalizeUri(uri), offset, limit },
		});
	}
	abstract(uri: string): Promise<string> {
		return this.request("GET", "/api/v1/content/abstract", { query: { uri: normalizeUri(uri) } });
	}
	overview(uri: string): Promise<string> {
		return this.request("GET", "/api/v1/content/overview", { query: { uri: normalizeUri(uri) } });
	}
	async downloadBytes(uri: string): Promise<Uint8Array> {
		const url = new URL(`${this.baseUrl}/api/v1/content/download`);
		url.searchParams.set("uri", normalizeUri(uri));
		const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new OVError(`HTTP ${response.status}`, response.status);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Read at a level: abstract (L0) / overview (L1) / read (L2 full). */
	async readContent(uri: string, level: "abstract" | "overview" | "read" = "abstract"): Promise<string> {
		try {
			if (level === "abstract") return await this.abstract(uri);
			if (level === "overview") return await this.overview(uri);
			return await this.read(uri);
		} catch (err) {
			if (err instanceof OVError && err.statusCode === 404) return "";
			throw err;
		}
	}

	// -- resources --------------------------------------------------------------
	addResource(source: string, opts: { reason?: string; to?: string } = {}): Promise<Json> {
		return this.request("POST", "/api/v1/resources", {
			body: { path: source, reason: opts.reason, to: opts.to },
		});
	}

	// -- sessions / memory commit -----------------------------------------------
	getSession(sessionId: string): Promise<Json> {
		return this.request("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
	}
	async sessionExists(sessionId: string): Promise<boolean> {
		try {
			await this.getSession(sessionId);
			return true;
		} catch (err) {
			if (err instanceof OVError && (err.statusCode === 404 || /not found/i.test(err.message))) return false;
			throw err;
		}
	}
	createSession(sessionId: string, memoryPolicyValue: Record<string, unknown>): Promise<Json> {
		return this.request("POST", "/api/v1/sessions", {
			body: { session_id: sessionId, memory_policy: memoryPolicyValue },
		});
	}
	/** vikingbot VikingClient.ensure_session. */
	async ensureSession(sessionId: string): Promise<Json> {
		try {
			return await this.getSession(sessionId);
		} catch (err) {
			if (!(err instanceof OVError) || (err.statusCode !== 404 && !/not found/i.test(err.message))) throw err;
			return await this.createSession(sessionId, memoryPolicy());
		}
	}
	batchAddMessages(sessionId: string, messages: Json[]): Promise<Json> {
		return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, {
			body: {
				messages: messages.map((m) => ({
					role: m.role,
					parts: [{ type: "text", text: m.content }],
					...(m.peer_id ? { peer_id: m.peer_id } : {}),
				})),
			},
		});
	}
	commitSession(sessionId: string, keepRecentCount = 0): Promise<Json> {
		return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
			body: { keep_recent_count: keepRecentCount },
		});
	}
	getTask(taskId: string): Promise<Json | null> {
		return this.request<Json>("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`).catch((err: unknown): Json | null => {
			if (err instanceof OVError && err.statusCode === 404) return null;
			throw err;
		});
	}
}

let client: OVClient | undefined;
function ov(): OVClient {
	if (!client) client = new OVClient(SERVER_URL, API_KEY);
	return client;
}

// ---------------------------------------------------------------------------
// Recall formatting — port of vikingbot MemoryStore._parse_viking_memory +
// _format_* helpers and _build_user_memory injection text
// ---------------------------------------------------------------------------

const MEMORY_TYPE_DESCRIPTIONS: Record<string, string> = {
	events: "Event memories. The URI path includes the event date.",
	entities:
		"Entity and topic memories. Use them for stable facts, attributes, relationships, and background about people, hobbies, places, or concepts.",
	preferences:
		"Preference memories. Use them for likes, dislikes, habits, recurring choices, and long-term personal tendencies.",
};

function getScore(m: Json): number {
	const v = Number(m.score ?? 0);
	return Number.isFinite(v) ? v : 0;
}
function getUri(m: Json): string {
	return String(m.uri ?? "");
}
function getAbstract(m: Json): string {
	return String(m.abstract ?? "");
}
function inferMemoryType(m: Json): string {
	const parts = getUri(m).trim().split("/").filter(Boolean);
	const idx = parts.indexOf("memories");
	return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : "";
}
function filenameFromUri(uri: string): string {
	const stripped = uri.replace(/\/+$/, "");
	return stripped ? stripped.split("/").pop()! : "";
}
function dedupeByUri(memories: Json[]): Json[] {
	const seen = new Set<string>();
	const out: Json[] = [];
	for (const m of memories) {
		const uri = getUri(m);
		if (!uri || seen.has(uri)) continue;
		seen.add(uri);
		out.push(m);
	}
	return out;
}

function formatFullMemory(idx: number, uri: string, score: number, content: string): string {
	return `<memory index="${idx}" type="full">\n  <uri>${uri}</uri>\n  <filename>${filenameFromUri(uri)}</filename>\n  <score>${score}</score>\n  <content>${content}</content>\n</memory>`;
}
function formatSummaryMemory(idx: number, uri: string, score: number, summary: string): string {
	return `<memory index="${idx}" type="summary">\n  <uri>${uri}</uri>\n  <filename>${filenameFromUri(uri)}</filename>\n  <score>${score}</score>\n  <summary>${summary}</summary>\n</memory>`;
}
function formatUriMemory(idx: number, uri: string, score: number): string {
	return `<memory index="${idx}" type="uri">\n  <uri>${uri}</uri>\n  <filename>${filenameFromUri(uri)}</filename>\n  <score>${score}</score>\n</memory>`;
}
function formatMemoryGroup(memoryType: string, memories: string[]): string {
	const description =
		MEMORY_TYPE_DESCRIPTIONS[memoryType] ??
		"Other retrieved memories. Use them when relevant and inspect URI entries if needed.";
	return `<memory_group type="${memoryType}">\n  <group_hint>${description}</group_hint>\n${memories.join("\n")}\n</memory_group>`;
}

/** vikingbot _extract_event_summary: text between "Summary:" and the next section. */
function extractEventSummary(content: string, fallback = ""): string {
	if (!content) return fallback.trim();
	const m = content.match(
		/^\s*Summary:\s*([\s\S]*?)(?:\n\s*\d{4}-\d{2}-\d{2}(?:\s*\([^)]+\))?\s*ChatLog:|\n\s*ChatLog:|\n\s*<!--\s*MEMORY_FIELDS|$)/i,
	);
	if (m) return m[1].replace(/\s+/g, " ").trim();
	return fallback.trim();
}

/** Port of MemoryStore._parse_viking_memory (type-quota path). */
async function parseVikingMemory(result: Json[], c: OVClient): Promise<string> {
	const filtered = result.filter((m) => getScore(m) >= RECALL_MIN_SCORE);
	if (filtered.length === 0) return "";

	const typeBudgets: Record<string, number> = {
		events: Math.floor(RECALL_MAX_CHARS * EVENT_CHAR_RATIO),
		entities: RECALL_MAX_CHARS - Math.floor(RECALL_MAX_CHARS * EVENT_CHAR_RATIO),
	};
	const groups = new Map<string, string[]>();
	const typeChars: Record<string, number> = {};
	let totalChars = 0;
	let preferenceFullCount = 0;
	const seenContent = new Set<string>();

	for (let idx = 0; idx < filtered.length; idx++) {
		const memory = filtered[idx];
		const uri = getUri(memory);
		const abstract = getAbstract(memory);
		const score = getScore(memory);
		const memoryType = inferMemoryType(memory) || "other";

		let content = "";
		try {
			content = await c.readContent(uri, "read");
		} catch {
			/* best-effort, matches vikingbot */
		}

		const contentKey = content || abstract || uri;
		if (contentKey && seenContent.has(contentKey)) continue;
		seenContent.add(contentKey);

		if (content) {
			const full = formatFullMemory(idx + 1, uri, score, content);
			let fullChars = full.length;
			if ([...groups.values()].some((g) => g.length > 0)) fullChars += 1;

			if (memoryType in typeBudgets) {
				if ((typeChars[memoryType] ?? 0) + fullChars <= typeBudgets[memoryType] && totalChars + fullChars <= RECALL_MAX_CHARS) {
					(groups.get(memoryType) ?? groups.set(memoryType, []).get(memoryType)!).push(full);
					typeChars[memoryType] = (typeChars[memoryType] ?? 0) + fullChars;
					totalChars += fullChars;
					continue;
				}
			} else if (memoryType === "preferences" && preferenceFullCount < PREFERENCE_FULL_LIMIT) {
				preferenceFullCount++;
				if (totalChars + fullChars <= RECALL_MAX_CHARS) {
					(groups.get(memoryType) ?? groups.set(memoryType, []).get(memoryType)!).push(full);
					totalChars += fullChars;
					continue;
				}
			}
			if (memoryType === "events") {
				const summary = extractEventSummary(content, abstract);
				if (summary) {
					(groups.get(memoryType) ?? groups.set(memoryType, []).get(memoryType)!).push(
						formatSummaryMemory(idx + 1, uri, score, summary),
					);
					continue;
				}
			}
		}
		(groups.get(memoryType) ?? groups.set(memoryType, []).get(memoryType)!).push(formatUriMemory(idx + 1, uri, score));
	}

	const ordered: string[] = [];
	const order = [...Object.keys(TYPE_QUOTAS), "other"];
	for (const t of order) {
		const g = groups.get(t);
		if (g?.length) ordered.push(formatMemoryGroup(t, g));
	}
	for (const [t, g] of groups) {
		if (!order.includes(t) && g.length) ordered.push(formatMemoryGroup(t, g));
	}
	return ordered.join("\n");
}

/** Port of MemoryStore._search_viking_memory_by_type_quota (single client, no peer fanout). */
async function searchVikingMemoryByTypeQuota(c: OVClient, query: string): Promise<Json[]> {
	const base = userScope();
	const target = PEER_ID ? `${base}/peers/${PEER_ID}/memories/` : `${base}/memories/`;
	const all: Json[] = [];
	for (const [memoryType, quota] of Object.entries(TYPE_QUOTAS)) {
		if (quota <= 0) continue;
		try {
			const result = await c.find(query, { targetUri: `${target.replace(/\/+$/, "")}/${memoryType}/`, limit: quota });
			const items = [...(result.memories ?? []), ...(result.resources ?? []), ...(result.skills ?? [])] as Json[];
			const ranked = dedupeByUri(items).sort((a, b) => getScore(b) - getScore(a)).slice(0, quota);
			all.push(...ranked);
		} catch {
			/* skip failed type, matches vikingbot's per-target try/except */
		}
	}
	return dedupeByUri(all);
}

/** Port of ContextBuilder._build_user_memory injection text. */
async function buildUserMemory(prompt: string): Promise<string> {
	if (!available() || !RECALL_ENABLED || !prompt.trim()) return "";
	try {
		const c = ov();
		let result = await searchVikingMemoryByTypeQuota(c, prompt);
		result = result.filter((m) => !getUri(m).replace(/\/+$/, "").endsWith("/profile.md"));
		if (result.length === 0) return "";
		const userMemory = await parseVikingMemory(result, c);
		if (!userMemory) return "";
		return (
			`## openviking_search(query=[user_query])\n### user memories:\n${userMemory}\n\n` +
			"## OpenViking Memory Retrieval\n" +
			"- For questions about the user's remembered facts, preferences, profile, or personal context, use openviking_search for the current question before saying there is no relevant record.\n" +
			"- A previous empty search result does not prove that a different follow-up question has no memory; search again when the requested fact changes.\n" +
			"- Injected memories are grouped by memory_type: events contain atomic time-based facts; entities contain stable topic/entity facts; preferences contain likes, habits, and recurring tendencies.\n" +
			"- Injected memory entries use three types: full means the full memory content is already shown; summary means only a summary is shown and the URI has more detail; uri means only the URI is shown and it may still point to key facts.\n" +
			"- For relevant summary or uri entries, use openviking_multi_read on their URIs to fetch full details to help you to resolve the query."
		);
	} catch {
		// vikingbot rule: recall failures never break the conversation
		return "";
	}
}

// ---------------------------------------------------------------------------
// Search item grouping — port of VikingSearchTool._extract/_filter/_format
// ---------------------------------------------------------------------------

const SEARCH_FANOUT_EXTRAS = ["viking://resources/"];

async function searchFanoutTargets(): Promise<string[]> {
	const base = userScope();
	return [...SEARCH_FANOUT_EXTRAS, `${base}/resources/`, `${base}/memories/`, `${base}/skills/`];
}

function extractSearchItems(result: Json): Json[] {
	const items: Json[] = [];
	for (const group of [result.memories, result.resources, result.skills]) {
		if (Array.isArray(group)) items.push(...group);
	}
	if (items.length === 0 && Array.isArray(result)) items.push(...(result as unknown as Json[]));
	return items;
}

function filterSearchItems(result: Json, minScore: number): Record<string, Json[]> {
	const grouped: Record<string, Json[]> = { memory: [], resource: [], skill: [] };
	for (const item of extractSearchItems(result)) {
		const score = getScore(item);
		if (score < minScore) continue;
		const raw = String(item.context_type ?? item.type ?? "").toLowerCase();
		const itemType = raw.includes("memory") ? "memory" : raw.includes("skill") ? "skill" : "resource";
		grouped[itemType].push({ uri: getUri(item), abstract: getAbstract(item), is_leaf: Boolean(item.is_leaf), score });
	}
	return grouped;
}

function buildGroupJson(items: Json[]): Json[] {
	return items.map((item, i) => ({
		index: i + 1,
		uri: item.uri,
		abstract: item.abstract,
		is_leaf: Boolean(item.is_leaf),
		score: Math.round(Number(item.score) * 1e6) / 1e6,
	}));
}

function formatSearchItemsJson(grouped: Record<string, Json[]>): string {
	const memories = buildGroupJson(grouped.memory);
	const resources = buildGroupJson(grouped.resource);
	const skills = buildGroupJson(grouped.skill);
	return JSON.stringify(
		{ count: memories.length + resources.length + skills.length, memories, resources, skills },
		null,
		2,
	);
}

// ---------------------------------------------------------------------------
// Tools — ports of bot/vikingbot/agent/tools/ov_file.py
// ---------------------------------------------------------------------------

type ToolResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

function text(textValue: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: textValue }], details: {}, isError };
}

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".ac3", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".flv", ".mkv", ".mov", ".mp4", ".webm", ".wmv"]);
const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
	".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};

function mediaKind(uri: string): "image" | "audio" | "video" | undefined {
	const suffix = uri.split("#")[0].split("?")[0].split(".").pop()?.toLowerCase() ?? "";
	const ext = suffix ? `.${suffix}` : "";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

let memoryCommitSeq = 1;

export default function (pi: ExtensionAPI) {
	if (!available()) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"pi-memory: disabled — set OPENVIKING_SERVER_URL and OPENVIKING_API_KEY to enable OpenViking memory.",
				"warning",
			);
		});
		return;
	}

	// Auto recall: inject relevant memories before each agent run
	// (vikingbot ContextBuilder.build_messages → _build_user_memory)
	pi.on("before_agent_start", async (event) => {
		try {
			const memory = await buildUserMemory(event.prompt);
			if (!memory) return;
			return {
				message: {
					customType: "pi-memory-recall",
					content: memory,
					display: false,
				},
			};
		} catch {
			return undefined;
		}
	});

	// ---- Auto session sync (vikingbot openviking_hooks.py §7.5) ------------------
	// Every turn: append unsynced user/assistant messages to a stable OV
	// session; commit (→ memory extraction) when the pending token count or
	// message count crosses a threshold. Never throws.
	interface SyncState {
		lastSyncedId: string | null;
		lastCommittedId: string | null;
	}

	interface SyncMsg {
		entryId: string;
		role: "user" | "assistant";
		content: string;
	}

	function collectSyncMessages(sm: { getEntries: () => unknown[]; getLeafId: () => string | null }): SyncMsg[] {
		const entries = buildContextEntries(sm.getEntries() as never, sm.getLeafId());
		const out: SyncMsg[] = [];
		for (const entry of entries) {
			if ((entry as { type?: string }).type !== "message") continue; // skips custom/recall injections
			const message = (entry as { message?: AgentMessage }).message;
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const content = message.content as unknown;
			const parts = (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) as Array<{ type: string; text?: string }>;
			const text = parts
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text as string)
			.join(" ")
			.trim();
			if (!text) continue; // skips pure toolCall turns
			out.push({ entryId: entry.id, role: message.role, content: text });
		}
		return out;
	}

	function loadSyncState(sm: { getEntries: () => unknown }): SyncState {
		const entries = sm.getEntries() as Array<{ type?: string; customType?: string; data?: SyncState }>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === SYNC_STATE_TYPE && e.data) return e.data;
		}
		return { lastSyncedId: null, lastCommittedId: null };
	}

	function estimateTokens(messages: SyncMsg[]): number {
		return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
	}

	if (AUTO_SYNC) {
		pi.on("agent_settled", async (_event, ctx2) => {
			try {
				const sm = ctx2.sessionManager;
				const messages = collectSyncMessages(sm);
				if (messages.length === 0) return;
				const state = loadSyncState(sm);
				const lastIdx = state.lastSyncedId ? messages.findIndex((m) => m.entryId === state.lastSyncedId) : -1;
				const unsynced = messages.slice(lastIdx + 1);
				if (unsynced.length === 0) return;

				const c = ov();
				const sessionId = String(sm.getSessionId() ?? "pi").replace(/[^a-zA-Z0-9_-]/g, "_");
				await c.ensureSession(sessionId);
				await c.batchAddMessages(
					sessionId,
					unsynced.map((m) => ({ role: m.role, content: m.content, ...(PEER_ID ? { peer_id: PEER_ID } : {}) })),
				);

				// pending-since-last-commit spans committed + newly appended messages
				const commitIdx = state.lastCommittedId ? messages.findIndex((m) => m.entryId === state.lastCommittedId) : -1;
				const pending = messages.slice(commitIdx + 1);
				const pendingTokens = estimateTokens(pending);
				let committed = false;
				if (pendingTokens >= COMMIT_TOKEN_THRESHOLD || pending.length >= MEMORY_WINDOW) {
					await c.commitSession(sessionId, COMMIT_KEEP_RECENT);
					committed = true;
				}

				pi.appendEntry(SYNC_STATE_TYPE, {
					lastSyncedId: messages[messages.length - 1].entryId,
					lastCommittedId: committed ? messages[messages.length - 1].entryId : state.lastCommittedId,
				} satisfies SyncState);
				if (committed) {
					ctx2.ui.notify(`pi-memory: session synced & committed (${pending.length} messages) — memory extraction running`, "info");
				}
			} catch {
				// vikingbot rule: sync failures never break the conversation
			}
		});
	}

	// ---- openviking_list ------------------------------------------------------
	pi.registerTool({
		name: "openviking_list",
		label: "OpenViking List",
		description: "List resources in a OpenViking folder path.",
		promptSnippet: "Browse OpenViking resources with openviking_list.",
		parameters: Type.Object({
			uri: Type.Optional(Type.String({ description: "Parent Viking URI to list. Defaults to viking://", default: "viking://" })),
			recursive: Type.Optional(Type.Boolean({ description: "Whether to list recursively", default: false })),
		}),
		async execute(_id, params) {
			try {
				const entries = await ov().ls(params.uri ?? "viking://", { recursive: params.recursive ?? false });
				if (!entries.length) return text(`No resources found at ${params.uri ?? "viking://"}`);
				return text(
					entries
						.map((e) => `{'name': ${e.name ?? String(e.uri ?? "").split("/").pop()}, 'size': ${e.size}, 'uri': ${e.uri}, 'isDir': ${e.isDir}}`)
						.join("\n"),
				);
			} catch (e) {
				return text(`Error listing Viking resources: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	// ---- openviking_search ------------------------------------------------------
	pi.registerTool({
		name: "openviking_search",
		label: "OpenViking Search",
		description:
			"Using query to search for resources (knowledge, code, files, workflow, etc.) in OpenViking. " +
			"Result: Only URIs and summaries are included here. To view the full content, use openviking_multi_read tool. " +
			"This operation performs semantic retrieval, not full character matching. " +
			"Avoid duplicate calls with the same intent in the same turn, but do search again for a new user question or a follow-up that asks for a different remembered fact. " +
			"For questions about the user's memory, profile, preferences, or personal facts, use this tool before concluding no relevant record exists.",
		promptSnippet: "Semantic search over OpenViking memories/resources/skills with openviking_search.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			target_uri: Type.Optional(
				Type.String({ description: "Optional target URI to limit search scope, if is None, then search the entire range.(e.g., viking://resources/)" }),
			),
			min_score: Type.Optional(Type.Number({ description: "Minimum relevance score threshold", default: 0.35 })),
		}),
		async execute(_id, params) {
			try {
				const minScore = params.min_score ?? 0.35;
				const grouped: Record<string, Json[]> = { memory: [], resource: [], skill: [] };
				const targets = params.target_uri ? [params.target_uri] : await searchFanoutTargets();
				for (const target of targets) {
					try {
						const result = await ov().search(params.query, { targetUri: target, limit: 10 });
						for (const [type, items] of Object.entries(filterSearchItems(result, minScore))) {
							grouped[type].push(...items);
						}
					} catch (e) {
						if (targets.length === 1) throw e;
						/* skip failed fanout target */
					}
				}
				const total = grouped.memory.length + grouped.resource.length + grouped.skill.length;
				if (total === 0) return text(`No results found for query: ${params.query}`);
				return text(formatSearchItemsJson(grouped));
			} catch (e) {
				return text(`Error searching Viking: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	// ---- openviking_multi_read ------------------------------------------------------
	pi.registerTool({
		name: "openviking_multi_read",
		label: "OpenViking Multi Read",
		description:
			"Read content from multiple OpenViking resources concurrently. By default returns complete content. " +
			"Large files (over 512 KB) are not returned in full: first use openviking_grep to locate relevant lines, " +
			"then read a bounded window with offset and limit (line numbers, 0-indexed).",
		promptSnippet: "Read full contents of OpenViking URIs with openviking_multi_read.",
		parameters: Type.Object({
			uris: Type.Array(Type.String(), { description: 'List of Viking file URIs to read from (e.g., ["viking://resources/path/123.md"])' }),
			offset: Type.Optional(Type.Integer({ description: "Starting line number (0-indexed) for bounded reads; default 0.", default: 0 })),
			limit: Type.Optional(Type.Integer({ description: "Number of lines to read; -1 reads to the end (default).", default: -1 })),
		}),
		async execute(_id, params) {
			const uris = params.uris ?? [];
			if (!uris.length) return text("Error: No URIs provided.", true);
			const offset = params.offset ?? 0;
			const limit = params.limit ?? -1;
			const imageIndexes = uris.map((u, i) => (mediaKind(u) === "image" ? i : -1)).filter((i) => i >= 0);
			const inlineImages = new Set(imageIndexes.slice(0, MAX_INLINE_IMAGES));
			const results = await Promise.all(
				uris.map(async (uri, index) => {
					try {
						const kind = mediaKind(uri);
						if (kind === "image") {
							if (!inlineImages.has(index)) {
								return { uri, content: `Image was not attached because one tool result supports at most ${MAX_INLINE_IMAGES} images. Read fewer images at once.`, success: false };
							}
							const stat = await ov().stat(uri);
							const size = Number(stat.size);
							if (!Number.isFinite(size) || size < 0) return { uri, content: "Image size is unavailable; cannot attach it safely.", success: false };
							if (size > MAX_INLINE_MEDIA_BYTES) return { uri, content: `Image is ${size} bytes; the inline limit is ${MAX_INLINE_MEDIA_BYTES} bytes.`, success: false };
							const data = await ov().downloadBytes(uri);
							const ext = `.${uri.split("#")[0].split("?")[0].split(".").pop()?.toLowerCase() ?? ""}`;
							const mime = IMAGE_MIME[ext];
							if (!mime) return { uri, content: "File bytes do not match a supported PNG, JPEG, GIF, or WebP image.", success: false };
							return { uri, content: `Image resource (${mime}, ${data.length} bytes).`, image: { type: "image" as const, data: Buffer.from(data).toString("base64"), mimeType: mime }, success: true };
						}
						if (kind === "audio" || kind === "video") {
							const content = await ov().readContent(uri, "overview");
							if (!content) return { uri, content: `No OpenViking textual overview is available for this ${kind} resource.`, success: false };
							return { uri, content, success: true };
						}
						const content = await ov().read(uri, offset, limit);
						return { uri, content, success: true };
					} catch (e) {
						return { uri, content: `Error reading ${uri}: ${e instanceof Error ? e.message : String(e)}`, success: false };
					}
				}),
			);
			const content: ToolResult["content"] = [];
			for (const r of results) {
				content.push({ type: "text", text: `${r.success ? "✅" : "❌"} ${r.uri}\n${r.content ?? ""}` });
				if (r.image) content.push(r.image);
			}
			return { content, details: { count: results.length } };
		},
	});

	// ---- openviking_grep ------------------------------------------------------
	pi.registerTool({
		name: "openviking_grep",
		label: "OpenViking Grep",
		description:
			"Search Viking resources using a regex pattern (like grep). " +
			"Result: Only URIs and summaries are included here. To view the full content, use openviking_multi_read tool. " +
			"Avoid duplicate calls with the same intent in the same turn.",
		promptSnippet: "Regex search across OpenViking content with openviking_grep.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern to search for" }),
			uri: Type.Optional(Type.String({ description: "Optional Viking URI to search within. Defaults to viking://", default: "viking://" })),
			case_insensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive search", default: false })),
		}),
		async execute(_id, params) {
			try {
				const result = await ov().grep(params.uri ?? "viking://", params.pattern, {
					caseInsensitive: params.case_insensitive ?? false,
				});
				const matches: Json[] = Array.isArray(result.matches) ? result.matches : [];
				if (!matches.length) return text(`No matches found for pattern: '${params.pattern}'`);
				const merged = new Map<string, Array<{ line: unknown; content: unknown }>>();
				for (const m of matches) {
					(merged.get(m.uri ?? "unknown") ?? merged.set(m.uri ?? "unknown", []).get(m.uri ?? "unknown")!).push({ line: m.line, content: m.content });
				}
				const lines = [`Found ${matches.length} match${matches.length !== 1 ? "es" : ""} for pattern '${params.pattern}':`];
				for (const [uri, uriMatches] of merged) {
					uriMatches.sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0));
					lines.push(`\n📄 ${uri}`);
					for (const m of uriMatches) {
						lines.push(`   Line ${m.line}:`);
						lines.push(`   ${m.content}`);
					}
				}
				return text(lines.join("\n"));
			} catch (e) {
				return text(`Error searching Viking with grep: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	// ---- openviking_glob ------------------------------------------------------
	pi.registerTool({
		name: "openviking_glob",
		label: "OpenViking Glob",
		description:
			"Find Viking resources using glob patterns (like **/*.md, *.py). " +
			"Result: Only URIs and summaries are included here. To view the full content, use openviking_multi_read tool.",
		promptSnippet: "Find OpenViking files by glob pattern with openviking_glob.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern to match (e.g., **/*.md, *.py, src/**/*.js)" }),
			uri: Type.Optional(Type.String({ description: "The whole Viking URI to search within (e.g., viking://resources/path/)", default: "" })),
		}),
		async execute(_id, params) {
			try {
				const result = await ov().glob(params.pattern, params.uri || "viking://");
				const matches: Json[] = Array.isArray(result.matches) ? result.matches : [];
				const count = Number(result.count ?? matches.length);
				if (!matches.length) return text(`No files found for pattern: ${params.pattern}`);
				const lines = [`Found ${count} file${count !== 1 ? "s" : ""}:`];
				for (const m of matches) lines.push(`📄 ${typeof m === "string" ? m : (m.uri ?? String(m))}`);
				return text(lines.join("\n"));
			} catch (e) {
				return text(`Error searching Viking with glob: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	// ---- openviking_add_resource ------------------------------------------------------
	pi.registerTool({
		name: "openviking_add_resource",
		label: "OpenViking Add Resource",
		description: "Add a resource (url like pic, git code or local file path) to OpenViking. This is a asynchronous operation.",
		promptSnippet: "Import URLs or local files into OpenViking with openviking_add_resource.",
		parameters: Type.Object({
			path: Type.String({ description: "Url or local file path" }),
			description: Type.String({ description: "Description of the resource" }),
			to: Type.Optional(Type.String({ description: "Optional exact target URI under viking://resources/. When omitted, OpenViking chooses the resource URI." })),
		}),
		async execute(_id, params) {
			try {
				const result = await ov().addResource(params.path, { reason: params.description, to: params.to });
				const rootUri = result?.root_uri ?? result?.uri ?? "";
				return rootUri ? text(`Successfully added resource: ${rootUri}`) : text("Failed to add resource", true);
			} catch (e) {
				return text(`Error adding resource to Viking: ${e instanceof Error ? e.message : String(e)}`, true);
			}
		},
	});

	// ---- openviking_memory_commit ------------------------------------------------------
	pi.registerTool({
		name: "openviking_memory_commit",
		label: "OpenViking Memory Commit",
		description: "When user has personal information needs to be remembered, Commit messages to OpenViking.",
		promptSnippet:
			"When the user asks to remember something, commit the minimal relevant user/assistant messages with openviking_memory_commit.",
		parameters: Type.Object({
			messages: Type.Array(
				Type.Object({
					role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
					content: Type.String(),
				}),
				{ description: "List of messages to commit, each with role, content" },
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const c = ov();
				const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
				const sourceSessionId = (ctx.sessionManager.getSessionId() ?? "pi").replace(/[^a-zA-Z0-9_-]/g, "_");
				const sessionId = `${sourceSessionId}__memory_commit__${timestamp}__${String(memoryCommitSeq++).padStart(4, "0")}`;

				// vikingbot VikingClient.commit: ensure_session → append → commit
				await c.ensureSession(sessionId);
				await c.batchAddMessages(
					sessionId,
					params.messages.map((m) => ({ ...m, ...(PEER_ID ? { peer_id: PEER_ID } : {}) })),
				);
				const commitResult = (await c.commitSession(sessionId, 0)) as Json;
				const archiveUri = commitResult.archive_uri ?? null;
				const taskId = commitResult.task_id ?? null;

				// poll the extraction task (vikingbot: 20×0.5s; real extraction can take longer)
				let task: Json | null = null;
				if (taskId) {
					for (let i = 0; i < 120; i++) {
						task = await c.getTask(String(taskId));
						if (task && (task.status === "completed" || task.status === "failed")) break;
						await new Promise((r) => setTimeout(r, 1000));
					}
				}

				// read memory diff
				const changedUris: Record<string, string[]> = { added_uris: [], updated_uris: [], deleted_uris: [] };
				if (task?.status === "completed" && archiveUri) {
					try {
						const raw = await c.readContent(`${archiveUri}/memory_diff.json`, "read");
						if (raw) {
							const diff = JSON.parse(raw) as Json;
							const ops = diff.operations ?? {};
							changedUris.added_uris = (ops.adds ?? []).map((x: Json) => x.uri).filter(Boolean);
							changedUris.updated_uris = (ops.updates ?? []).map((x: Json) => x.uri).filter(Boolean);
							changedUris.deleted_uris = (ops.deletes ?? []).map((x: Json) => x.uri).filter(Boolean);
						}
					} catch {
						/* best-effort */
					}
				}

				return text(
					JSON.stringify(
						{
							status: "success",
							session_id: sessionId,
							memory_commit_session_id: sessionId,
							source_session_id: sourceSessionId,
							message_count: params.messages.length,
							archived: commitResult.archived ?? null,
							...changedUris,
							archive_uri: archiveUri,
							memory_diff_uri: archiveUri ? `${archiveUri}/memory_diff.json` : null,
							task_id: taskId,
							task_status: task?.status ?? null,
						},
						null,
						2,
					),
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				const friendly = message.includes("403 Forbidden") ? "HTTP 403 Forbidden" : message;
				return text(`Error: committing to Viking failed: ${friendly}`, true);
			}
		},
	});

	// ---- /memory command ------------------------------------------------------
	pi.registerCommand("memory", {
		description: "pi-memory: show OpenViking connection info and recall config",
		handler: async (_args, ctx) => {
			const base = userScope();
			const memoryTarget = PEER_ID ? `${base}/peers/${PEER_ID}/memories/` : `${base}/memories/`;
			const lines = [
				`server: ${SERVER_URL}`,
				`auth: api key${ACCOUNT ? ` + account ${ACCOUNT}` : ""}${USER ? ` + user ${USER}` : ""}`,
				`actor peer: ${PEER_ID || "(none — self memory space)"}`,
				`user scope: ${base}`,
				`memory target: ${memoryTarget}`,
				`recall: ${RECALL_ENABLED ? `on (events ${TYPE_QUOTAS.events}, entities ${TYPE_QUOTAS.entities}, preferences ${TYPE_QUOTAS.preferences}, budget ${RECALL_MAX_CHARS} chars)` : "off"}`,
			];
			try {
				const entries = await ov().ls(memoryTarget, { nodeLimit: 20 });
				lines.push(`memory roots: ${entries.map((e) => String(e.uri ?? "").split("/").pop()).join(", ") || "(empty)"}`);
				ctx.ui.notify(`pi-memory\n${lines.join("\n")}`, "info");
			} catch (e) {
				ctx.ui.notify(`pi-memory\n${lines.join("\n")}\nconnection check failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
}
