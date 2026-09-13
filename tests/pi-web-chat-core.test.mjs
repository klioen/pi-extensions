import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../packages/pi-web/lib/chat-core.cjs";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_ID = "019c6e27-e55b-73d1-87d8-4e01f1f75043";
const RUN_ID = "019c7714-3b77-74d1-9866-e1f484aae2ab";

function assertChatError(run, code, field) {
	assert.throws(run, (error) => {
		assert.ok(error instanceof ChatCoreError);
		assert.equal(error.code, code);
		if (field) assert.equal(error.field, field);
		return true;
	});
}

test("chat message validation accepts canonical UUIDs and preserves non-empty text", () => {
	assert.deepEqual(validateChatMessageInput({ requestId: REQUEST_ID, sessionId: SESSION_ID, text: "  hello\n" }), {
		requestId: REQUEST_ID,
		sessionId: SESSION_ID,
		text: "  hello\n",
	});
	assert.equal(CHAT_LIMITS.maxMessageBytes, 64 * 1024);
});

test("chat message validation has stable errors for malformed IDs, empty text, and UTF-8 byte overflow", () => {
	assertChatError(() => validateChatMessageInput(null), "INVALID_CHAT_MESSAGE");
	assertChatError(() => validateChatMessageInput({ requestId: "not-a-uuid", sessionId: SESSION_ID, text: "hello" }), "INVALID_CHAT_MESSAGE", "requestId");
	assertChatError(() => validateChatMessageInput({ requestId: REQUEST_ID, sessionId: "", text: "hello" }), "INVALID_CHAT_MESSAGE", "sessionId");
	assertChatError(() => validateChatMessageInput({ requestId: REQUEST_ID, sessionId: SESSION_ID, text: " \n\t " }), "INVALID_CHAT_MESSAGE", "text");
	assertChatError(() => validateChatMessageInput({ requestId: REQUEST_ID, sessionId: SESSION_ID, text: "界".repeat(21_846) }), "MESSAGE_TOO_LARGE", "text");
});

test("run state transitions allow only queued/running/terminal lifecycle paths", () => {
	assert.deepEqual(RUN_STATES, ["queued", "running", "done", "killed", "failed"]);
	assert.equal(transitionRunState("queued", "running"), "running");
	assert.equal(transitionRunState("running", "done"), "done");
	assert.equal(transitionRunState("running", "killed"), "killed");
	assert.equal(transitionRunState("running", "failed"), "failed");
	assert.equal(transitionRunState("done", "done"), "done");
	assertChatError(() => transitionRunState("queued", "done"), "INVALID_RUN_TRANSITION");
	assertChatError(() => transitionRunState("done", "running"), "INVALID_RUN_TRANSITION");
	assertChatError(() => transitionRunState("unknown", "running"), "INVALID_RUN_STATE");

	const machine = createRunStateMachine("queued");
	assert.equal(machine.state, "queued");
	assert.equal(machine.transition("running"), "running");
	assert.equal(machine.transition("killed"), "killed");
	assert.equal(machine.isTerminal(), true);
});

test("request idempotency cache returns the original value without invoking work twice", () => {
	let now = 1_000;
	let calls = 0;
	const cache = createRequestIdempotencyCache({ maxEntries: 2, ttlMs: 100, now: () => now });
	const first = cache.getOrCreate(REQUEST_ID, () => ({ accepted: true, sequence: ++calls }));
	const duplicate = cache.getOrCreate(REQUEST_ID, () => ({ accepted: true, sequence: ++calls }));
	assert.deepEqual(first, { duplicate: false, value: { accepted: true, sequence: 1 } });
	assert.deepEqual(duplicate, { duplicate: true, value: first.value });
	assert.equal(calls, 1);

	const secondId = "123e4567-e89b-42d3-a456-426614174001";
	const thirdId = "123e4567-e89b-42d3-a456-426614174002";
	cache.set(secondId, { accepted: true, sequence: 2 });
	cache.set(thirdId, { accepted: true, sequence: 3 });
	assert.equal(cache.has(REQUEST_ID), false, "oldest entry is evicted at capacity");
	now += 101;
	assert.equal(cache.get(thirdId), undefined, "expired entries are removed");
	assert.equal(cache.size, 0);
});

test("event data keeps raw allowed content while bounding structure and unknown fields", () => {
	const circular = { visible: "ok", password: "secret" };
	circular.self = circular;
	const data = sanitizeEventData("tool.completed", {
		toolCallId: "tool-1",
		toolName: "bash",
		status: "done",
		result: { output: "x".repeat(200), nested: circular },
		credentials: "must-not-leak",
		internalContext: { cwd: "/secret" },
	}, { maxStringBytes: 32, maxDepth: 3 });
	assert.equal(data.toolName, "bash");
	assert.equal(data.credentials, undefined);
	assert.equal(data.internalContext, undefined);
	assert.equal(data.result.output.endsWith("…"), true);
	assert.equal(data.result.nested.visible, "ok");
	assert.equal(data.result.nested.password, "secret");
	assert.equal(data.result.nested.self, "[Truncated]");
	assert.equal(data.truncated, true);
	assertChatError(() => sanitizeEventData("unknown.event", {}), "INVALID_EVENT_TYPE");
});

test("safe envelopes omit unknown fields and enforce a serialized per-event byte bound", () => {
	const envelope = createSafeEventEnvelope({
		id: 7,
		type: "message.completed",
		timestamp: 123,
		sessionId: SESSION_ID,
		runId: RUN_ID,
		requestId: REQUEST_ID,
		data: { messageId: "m1", role: "assistant", text: "界".repeat(10_000), thinking: "hidden" },
		extra: "hidden",
	}, { maxEventBytes: 1_024, maxStringBytes: 20_000 });
	assert.deepEqual(Object.keys(envelope), ["id", "type", "timestamp", "sessionId", "runId", "requestId", "data"]);
	assert.equal(envelope.data.thinking, undefined);
	assert.equal(envelope.data.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= 1_024);
});

test("reasoning events preserve raw bounded display text", () => {
	const envelope = createSafeEventEnvelope({
		id: 8,
		type: "reasoning.completed",
		timestamp: 124,
		sessionId: SESSION_ID,
		runId: RUN_ID,
		data: { messageId: "reasoning-m1-0", parentMessageId: "m1", role: "reasoning", text: "Inspect cwd:/etc/shadow and file:///Users/alice/private Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature", status: "done", thinking: "hidden", signature: "hidden", details: { token: "hidden" } },
	});
	assert.equal(envelope.type, "reasoning.completed");
	assert.equal(envelope.data.messageId, "reasoning-m1-0");
	assert.equal(envelope.data.parentMessageId, "m1");
	assert.equal(envelope.data.role, "reasoning");
	assert.match(envelope.data.text, /\/etc\/shadow.*\/Users\/alice.*eyJhbGci/);
	assert.equal(envelope.data.thinking, undefined);
	assert.equal(envelope.data.signature, undefined);
	assert.equal(envelope.data.details, undefined);
	const delta = createSafeEventEnvelope({ ...envelope, type: "reasoning.delta", data: { messageId: "reasoning-m1-0", parentMessageId: "m1", blockIndex: 0, role: "reasoning", delta: "raw token=secret" } });
	assert.equal(delta.data.delta, "raw token=secret");
});

test("event hub publishes monotonic safe envelopes and supports unsubscribe", () => {
	let now = 10_000;
	const hub = createChatEventHub({ now: () => now });
	const received = [];
	const unsubscribe = hub.subscribe((event) => received.push(event));
	const first = hub.publish({ type: "request.accepted", sessionId: SESSION_ID, requestId: REQUEST_ID, data: { accepted: true, delivery: "immediate", secret: "no" } });
	now += 1;
	const second = hub.publish({ type: "run.started", sessionId: SESSION_ID, runId: RUN_ID, requestId: REQUEST_ID, data: { state: "running" } });
	unsubscribe();
	hub.publish({ type: "run.settled", sessionId: SESSION_ID, runId: RUN_ID, data: { state: "done" } });
	unsubscribe();
	assert.deepEqual(received.map((event) => event.id), [1, 2]);
	assert.equal(first.id, 1);
	assert.equal(second.id, 2);
	assert.equal(first.data.secret, undefined);
	assert.equal(hub.cursor, 3);
});

test("event hub replays after a cursor and resets when count or age retention expires", () => {
	let now = 0;
	const hub = createChatEventHub({ maxEvents: 2, maxAgeMs: 100, now: () => now });
	const publish = (text) => hub.publish({ type: "message.delta", sessionId: SESSION_ID, runId: RUN_ID, data: { messageId: "m1", delta: text } });
	publish("one");
	now = 10; publish("two");
	assert.deepEqual(hub.replay(1).events.map((event) => event.id), [2]);
	now = 20; publish("three");
	assert.deepEqual(hub.replay(0), { reset: true, reason: "SSE_REPLAY_EXPIRED", cursor: 3, events: [] });
	assert.deepEqual(hub.replay(1).events.map((event) => event.id), [2, 3]);

	now = 200;
	assert.deepEqual(hub.replay(2), { reset: true, reason: "SSE_REPLAY_EXPIRED", cursor: 3, events: [] });
	assert.deepEqual(hub.replay(3), { reset: false, cursor: 3, events: [] });
});
