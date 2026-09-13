"use strict";

const CHAT_LIMITS = Object.freeze({
	maxMessageBytes: 64 * 1024,
	maxEventBytes: 128 * 1024,
	maxEventStringBytes: 64 * 1024,
	maxEventDepth: 8,
	maxArrayItems: 100,
	maxObjectKeys: 100,
	maxReplayEvents: 512,
	replayMaxAgeMs: 5 * 60_000,
	maxRequestEntries: 1_024,
	requestTtlMs: 10 * 60_000,
});

const RUN_STATES = Object.freeze(["queued", "running", "done", "killed", "failed"]);
const RUN_STATE_SET = new Set(RUN_STATES);
const TERMINAL_RUN_STATES = new Set(["done", "killed", "failed"]);
const RUN_TRANSITIONS = Object.freeze({
	queued: new Set(["running"]),
	running: new Set(["done", "killed", "failed"]),
	done: new Set(),
	killed: new Set(),
	failed: new Set(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EVENT_FIELDS = Object.freeze({
	snapshot: ["available", "currentSessionId", "sessionName", "cwd", "idle", "hasPendingMessages", "activeRun", "eventCursor", "capabilities"],
	"session.changed": ["previousSessionId", "currentSessionId", "available", "reason"],
	"request.accepted": ["accepted", "delivery", "state"],
	"run.started": ["state"],
	"message.started": ["messageId", "parentMessageId", "blockIndex", "role", "text"],
	"message.delta": ["messageId", "parentMessageId", "blockIndex", "role", "delta"],
	"message.completed": ["messageId", "parentMessageId", "blockIndex", "role", "text", "status", "error"],
	"reasoning.started": ["messageId", "parentMessageId", "blockIndex", "role", "text"],
	"reasoning.delta": ["messageId", "parentMessageId", "blockIndex", "role", "delta"],
	"reasoning.completed": ["messageId", "parentMessageId", "blockIndex", "role", "text", "status"],
	"tool.started": ["toolCallId", "parentMessageId", "blockIndex", "toolName", "status", "arguments"],
	"tool.updated": ["toolCallId", "parentMessageId", "blockIndex", "toolName", "status", "arguments", "result"],
	"tool.completed": ["toolCallId", "parentMessageId", "blockIndex", "toolName", "status", "arguments", "result", "error"],
	"run.abort_requested": ["state"],
	"run.settled": ["state", "error", "historyRevision"],
	"stream.reset": ["reason", "cursor"],
	"runtime.error": ["code", "message", "recoverable"],
});

// Nested tool arguments/results preserve local content while bounding shape.
// Reject prototype keys, invalid key syntax, cycles, excessive depth, and unsupported values.
const SAFE_NESTED_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BLOCKED_NESTED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALWAYS_BLOCKED_FIELDS = /^(?:__proto__|prototype|constructor)$/;

class ChatCoreError extends Error {
	constructor(code, message, options = {}) {
		super(message);
		this.name = "ChatCoreError";
		this.code = code;
		if (options.field !== undefined) this.field = options.field;
		if (options.details !== undefined) this.details = options.details;
	}
}

function positiveInteger(value, fallback, name) {
	const resolved = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${name} must be a positive integer`);
	return resolved;
}

function validateUuid(value, field) {
	if (typeof value !== "string" || !UUID_RE.test(value)) {
		throw new ChatCoreError("INVALID_CHAT_MESSAGE", `${field} must be a UUID`, { field });
	}
	return value;
}

function validateChatMessageInput(input, options = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new ChatCoreError("INVALID_CHAT_MESSAGE", "Chat message must be an object");
	}
	const requestId = validateUuid(input.requestId, "requestId");
	const sessionId = validateUuid(input.sessionId, "sessionId");
	if (typeof input.text !== "string" || !input.text.trim()) {
		throw new ChatCoreError("INVALID_CHAT_MESSAGE", "text must not be empty", { field: "text" });
	}
	const maxMessageBytes = positiveInteger(options.maxMessageBytes, CHAT_LIMITS.maxMessageBytes, "maxMessageBytes");
	if (Buffer.byteLength(input.text, "utf8") > maxMessageBytes) {
		throw new ChatCoreError("MESSAGE_TOO_LARGE", `text exceeds ${maxMessageBytes} UTF-8 bytes`, { field: "text" });
	}
	return { requestId, sessionId, text: input.text };
}

function transitionRunState(current, next) {
	if (!RUN_STATE_SET.has(current) || !RUN_STATE_SET.has(next)) {
		throw new ChatCoreError("INVALID_RUN_STATE", "Unknown run state");
	}
	if (current === next) return current;
	if (!RUN_TRANSITIONS[current].has(next)) {
		throw new ChatCoreError("INVALID_RUN_TRANSITION", `Cannot transition run from ${current} to ${next}`, { details: { current, next } });
	}
	return next;
}

function createRunStateMachine(initialState = "queued") {
	if (!RUN_STATE_SET.has(initialState)) throw new ChatCoreError("INVALID_RUN_STATE", "Unknown initial run state");
	let state = initialState;
	return {
		get state() { return state; },
		transition(next) { state = transitionRunState(state, next); return state; },
		isTerminal() { return TERMINAL_RUN_STATES.has(state); },
	};
}

function createRequestIdempotencyCache(options = {}) {
	const maxEntries = positiveInteger(options.maxEntries, CHAT_LIMITS.maxRequestEntries, "maxEntries");
	const ttlMs = positiveInteger(options.ttlMs, CHAT_LIMITS.requestTtlMs, "ttlMs");
	const now = options.now ?? Date.now;
	if (typeof now !== "function") throw new TypeError("now must be a function");
	const entries = new Map();

	function prune() {
		const cutoff = now() - ttlMs;
		for (const [key, entry] of entries) if (entry.createdAt <= cutoff) entries.delete(key);
		while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
	}
	function set(key, value) {
		validateUuid(key, "requestId");
		prune();
		if (entries.has(key)) entries.delete(key);
		entries.set(key, { value, createdAt: now() });
		prune();
		return value;
	}
	function get(key) {
		prune();
		return entries.get(key)?.value;
	}
	return {
		get size() { prune(); return entries.size; },
		has(key) { prune(); return entries.has(key); },
		get,
		set,
		delete(key) { return entries.delete(key); },
		clear() { entries.clear(); },
		getOrCreate(key, create) {
			validateUuid(key, "requestId");
			if (typeof create !== "function") throw new TypeError("create must be a function");
			prune();
			const existing = entries.get(key);
			if (existing) return { duplicate: true, value: existing.value };
			const value = create();
			set(key, value);
			return { duplicate: false, value };
		},
	};
}

function truncateUtf8(value, maxBytes) {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	const suffix = "…";
	const suffixBytes = Buffer.byteLength(suffix);
	if (maxBytes < suffixBytes) return { value: "", truncated: true };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") + suffixBytes <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return { value: value.slice(0, low) + suffix, truncated: true };
}

function safeValue(value, context, depth) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const result = truncateUtf8(value, context.maxStringBytes);
		if (result.truncated) context.truncated = true;
		return result.value;
	}
	if (typeof value !== "object") { context.truncated = true; return undefined; }
	if (depth >= context.maxDepth || context.seen.has(value)) { context.truncated = true; return "[Truncated]"; }
	context.seen.add(value);
	let result;
	if (Array.isArray(value)) {
		result = [];
		for (const item of value.slice(0, context.maxArrayItems)) {
			const safe = safeValue(item, context, depth + 1);
			if (safe !== undefined) result.push(safe);
		}
		if (value.length > context.maxArrayItems) context.truncated = true;
	} else {
		result = {};
		let included = 0;
		for (const [key, item] of Object.entries(value)) {
			if (included >= context.maxObjectKeys) { context.truncated = true; break; }
			if (!SAFE_NESTED_KEY_RE.test(key) || BLOCKED_NESTED_KEYS.has(key) || ALWAYS_BLOCKED_FIELDS.test(key)) continue;
			const safe = safeValue(item, context, depth + 1);
			if (safe !== undefined) { result[key] = safe; included++; }
		}
	}
	context.seen.delete(value);
	return result;
}

function normalizeEventText(value) {
	return value;
}

function sanitizeEventData(type, data, options = {}) {
	const allowed = EVENT_FIELDS[type];
	if (!allowed) throw new ChatCoreError("INVALID_EVENT_TYPE", `Unsupported chat event type: ${type}`);
	const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
	const context = {
		maxStringBytes: positiveInteger(options.maxStringBytes, CHAT_LIMITS.maxEventStringBytes, "maxStringBytes"),
		maxDepth: positiveInteger(options.maxDepth, CHAT_LIMITS.maxEventDepth, "maxDepth"),
		maxArrayItems: positiveInteger(options.maxArrayItems, CHAT_LIMITS.maxArrayItems, "maxArrayItems"),
		maxObjectKeys: positiveInteger(options.maxObjectKeys, CHAT_LIMITS.maxObjectKeys, "maxObjectKeys"),
		seen: new WeakSet(),
		truncated: false,
	};
	const result = {};
	for (const key of allowed) {
		if (!(key in source) || ALWAYS_BLOCKED_FIELDS.test(key)) continue;
		const raw = type.startsWith("reasoning.") && (key === "text" || key === "delta") && typeof source[key] === "string"
			? normalizeEventText(source[key])
			: source[key];
		const safe = safeValue(raw, context, 0);
		if (safe !== undefined) result[key] = safe;
	}
	if (context.truncated) result.truncated = true;
	return result;
}

function validateEnvelopeIdentity(event) {
	if (!event || typeof event !== "object" || Array.isArray(event)) throw new ChatCoreError("INVALID_EVENT", "Chat event must be an object");
	if (!EVENT_FIELDS[event.type]) throw new ChatCoreError("INVALID_EVENT_TYPE", `Unsupported chat event type: ${event.type}`);
	if (!Number.isSafeInteger(event.id) || event.id <= 0) throw new ChatCoreError("INVALID_EVENT", "Event id must be a positive integer", { field: "id" });
	if (!Number.isFinite(event.timestamp) || event.timestamp < 0) throw new ChatCoreError("INVALID_EVENT", "Event timestamp must be non-negative", { field: "timestamp" });
	validateUuid(event.sessionId, "sessionId");
	if (event.runId !== undefined) validateUuid(event.runId, "runId");
	if (event.requestId !== undefined) validateUuid(event.requestId, "requestId");
}

function createSafeEventEnvelope(event, options = {}) {
	validateEnvelopeIdentity(event);
	const maxEventBytes = positiveInteger(options.maxEventBytes, CHAT_LIMITS.maxEventBytes, "maxEventBytes");
	let maxStringBytes = positiveInteger(options.maxStringBytes, CHAT_LIMITS.maxEventStringBytes, "maxStringBytes");
	let envelope;
	for (;;) {
		envelope = {
			id: event.id,
			type: event.type,
			timestamp: event.timestamp,
			sessionId: event.sessionId,
			...(event.runId === undefined ? {} : { runId: event.runId }),
			...(event.requestId === undefined ? {} : { requestId: event.requestId }),
			data: sanitizeEventData(event.type, event.data, { ...options, maxStringBytes }),
		};
		if (Buffer.byteLength(JSON.stringify(envelope), "utf8") <= maxEventBytes) return envelope;
		if (maxStringBytes <= 8) break;
		maxStringBytes = Math.max(8, Math.floor(maxStringBytes / 2));
	}
	const identityKeys = ["messageId", "toolCallId", "toolName", "role", "state", "status", "code", "reason"];
	const minimalData = { truncated: true };
	for (const key of identityKeys) if (typeof envelope.data[key] === "string") minimalData[key] = truncateUtf8(envelope.data[key], 32).value;
	envelope.data = minimalData;
	if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxEventBytes) {
		throw new ChatCoreError("EVENT_TOO_LARGE", `Event identity exceeds ${maxEventBytes} bytes`);
	}
	return envelope;
}

function createChatEventHub(options = {}) {
	const maxEvents = positiveInteger(options.maxEvents, CHAT_LIMITS.maxReplayEvents, "maxEvents");
	const maxAgeMs = positiveInteger(options.maxAgeMs, CHAT_LIMITS.replayMaxAgeMs, "maxAgeMs");
	const now = options.now ?? Date.now;
	if (typeof now !== "function") throw new TypeError("now must be a function");
	const envelopeOptions = options.envelopeOptions ?? {};
	const subscribers = new Set();
	const events = [];
	let cursor = 0;

	function prune() {
		const cutoff = now() - maxAgeMs;
		while (events.length && events[0].timestamp <= cutoff) events.shift();
		while (events.length > maxEvents) events.shift();
	}
	function publish(event) {
		const timestamp = event.timestamp ?? now();
		const envelope = createSafeEventEnvelope({ ...event, id: ++cursor, timestamp }, envelopeOptions);
		events.push(envelope);
		prune();
		for (const listener of [...subscribers]) listener(envelope);
		return envelope;
	}
	function replay(afterId = 0) {
		if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ChatCoreError("INVALID_EVENT_CURSOR", "Event cursor must be a non-negative integer");
		prune();
		if (afterId > cursor || (afterId < cursor && (!events.length || afterId < events[0].id - 1))) {
			return { reset: true, reason: "SSE_REPLAY_EXPIRED", cursor, events: [] };
		}
		return { reset: false, cursor, events: events.filter((event) => event.id > afterId) };
	}
	return {
		get cursor() { return cursor; },
		get size() { prune(); return events.length; },
		publish,
		replay,
		subscribe(listener) {
			if (typeof listener !== "function") throw new TypeError("listener must be a function");
			subscribers.add(listener);
			let active = true;
			return () => { if (active) { active = false; subscribers.delete(listener); } };
		},
		clear() { events.length = 0; },
	};
}

module.exports = {
	CHAT_LIMITS,
	RUN_STATES,
	ChatCoreError,
	createChatEventHub,
	createRequestIdempotencyCache,
	createRunStateMachine,
	createSafeEventEnvelope,
	sanitizeEventData,
	transitionRunState,
	validateChatMessageInput,
};
