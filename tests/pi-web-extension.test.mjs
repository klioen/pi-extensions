import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRequire = createRequire(piCli);
const { createJiti } = piRequire("jiti");
const PI_ENTRY = resolve(dirname(piCli), "../index.js");
const EXTENSION_URL = new URL("../packages/pi-web/extensions/pi-web.ts", import.meta.url);
const serverModule = require("../packages/pi-web/server/server.cjs");

async function loadHarness({ idle = true, onSend } = {}) {
	const handlers = new Map();
	const sent = [];
	let adapter;
	const originalCreateServer = serverModule.createPiWebServer;
	serverModule.createPiWebServer = (options) => {
		adapter = options.chatAdapter;
		return { start: async () => {}, stop: async () => {}, address: () => ({ host: "127.0.0.1", port: 0, url: "http://127.0.0.1:0" }) };
	};
	const previousAutoStart = process.env.PI_WEB_AUTO_START;
	process.env.PI_WEB_AUTO_START = "1";
	try {
		const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": PI_ENTRY } });
		const extension = await jiti.import(EXTENSION_URL.href, { default: true });
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			getCommands() { return []; },
			setSessionName() {},
			sendUserMessage(text, options) { sent.push({ text, options }); onSend?.({ text, options, handlers }); },
		};
		extension(pi);
		const context = makeContext({ idle });
		await handlers.get("session_start")({ reason: "startup" }, context);
		assert.ok(adapter);
		return { adapter, context, handlers, sent };
	} finally {
		serverModule.createPiWebServer = originalCreateServer;
		if (previousAutoStart === undefined) delete process.env.PI_WEB_AUTO_START;
		else process.env.PI_WEB_AUTO_START = previousAutoStart;
	}
}

function makeContext({ idle, sessionId = "11111111-1111-4111-8111-111111111111" }) {
	return {
		cwd: "/tmp/project",
		hasUI: false,
		ui: { setStatus() {}, notify() {} },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		abort() {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionName: () => "session",
		},
	};
}

const requestId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// These tests intentionally execute the TypeScript extension through the same jiti loader family used by pi.
test("pi-web keeps one local run through nested agent_start and associates only matching Web inputs", async () => {
	const harness = await loadHarness({
		onSend({ text, handlers }) {
			handlers.get("input")({ source: "extension", text: "injected by another extension" });
			handlers.get("input")({ source: "extension", text });
		},
	});
	const events = [];
	harness.adapter.subscribe((event) => events.push(event));
	const acceptance = harness.adapter.sendUserMessage({ requestId: requestId(1), text: "web prompt" });
	assert.equal(acceptance.delivery, "immediate");
	assert.equal(events.at(-1).data.state, "accepted");

	harness.handlers.get("agent_start")({});
	const runId = events.at(-1).runId;
	assert.equal(events.at(-1).requestId, requestId(1));
	harness.handlers.get("agent_start")({});
	assert.equal(events.filter((event) => event.type === "run.started").length, 1);
	harness.handlers.get("agent_settled")({});
	const settled = events.find((event) => event.type === "run.settled");
	assert.equal(settled.runId, runId);
	assert.equal(settled.requestId, requestId(1));
});

test("pi-web switches request spans without inventing a terminal event before agent_settled", async () => {
	const harness = await loadHarness({ idle: false });
	const events = [];
	harness.adapter.subscribe((event) => events.push(event));
	for (const n of [2, 3]) harness.adapter.sendUserMessage({ requestId: requestId(n), text: "same" });
	assert.deepEqual(events.filter((event) => event.type === "request.accepted").map((event) => event.data.state), ["queued", "queued"]);

	harness.handlers.get("input")({ source: "extension", text: harness.sent[0].text });
	harness.handlers.get("agent_start")({});
	const firstUserMessage = { role: "user", content: "same" };
	harness.handlers.get("message_start")({ message: firstUserMessage });
	harness.handlers.get("message_end")({ message: firstUserMessage });

	harness.handlers.get("input")({ source: "extension", text: harness.sent[1].text });
	harness.handlers.get("agent_start")({});
	const started = events.filter((event) => event.type === "run.started");
	assert.equal(started.length, 2);
	assert.deepEqual(started.map((event) => event.requestId), [requestId(2), requestId(3)]);
	assert.equal(started[1].runId, started[0].runId);
	assert.equal(events.some((event) => event.type === "run.settled"), false);
	assert.deepEqual(
		events.filter((event) => event.type === "message.completed" && event.data.role === "user").map((event) => event.requestId),
		[requestId(2)],
	);

	harness.handlers.get("agent_settled")({});
	const settled = events.filter((event) => event.type === "run.settled");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].runId, started[1].runId);
	assert.equal(settled[0].requestId, requestId(3));
});

test("pi-web bounds pending Web requests with a stable error code", async () => {
	const harness = await loadHarness();
	for (let n = 10; n < 138; n++) harness.adapter.sendUserMessage({ requestId: requestId(n), text: `pending ${n}` });
	assert.throws(
		() => harness.adapter.sendUserMessage({ requestId: requestId(138), text: "overflow" }),
		(error) => error?.code === "CHAT_QUEUE_FULL",
	);
});

test("pi-web SSE preserves raw bounded chat content and stable generic errors", async () => {
	const harness = await loadHarness();
	const events = [];
	harness.adapter.subscribe((event) => events.push(event));
	harness.handlers.get("agent_start")({});
	const assistantMessage = { role: "assistant", content: [] };
	harness.handlers.get("message_start")({ message: assistantMessage });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First answer\n", partial: { content: [{ type: "text", text: "First answer\n" }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "First answer\n", partial: { content: [{ type: "text", text: "First answer\n" }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: { content: [{}, { type: "thinking", thinking: "", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Safe progress\nInspect /Us", partial: { content: [{}, { type: "thinking", thinking: "Safe progress\nInspect /Us", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "ers/alice/private Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\nTail", partial: { content: [{}, { type: "thinking", thinking: "Safe progress\nInspect /Users/alice/private Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\nTail", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "Safe progress\nInspect /Users/alice/private Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\nTail", partial: { content: [{}, { type: "thinking", thinking: "", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_start", contentIndex: 2, partial: { content: [{}, {}, { type: "thinking", thinking: "temporarily visible", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_end", contentIndex: 2, content: "temporarily visible", partial: { content: [{}, {}, { type: "thinking", thinking: "temporarily visible", redacted: false }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "MUST_NOT_LEAK", partial: { content: [{}, {}, { type: "thinking", thinking: "opaque", redacted: true }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: { type: "toolCall", id: "tool-1", name: "bash", arguments: {} }, partial: { content: [{}, {}, { type: "thinking", thinking: "MUST_NOT_LEAK", redacted: true }, { type: "toolCall", id: "tool-1", name: "bash", arguments: {} }] } } });
	harness.handlers.get("tool_execution_start")({ toolCallId: "tool-1", toolName: "bash", args: { command: "cat /secret", path: "/secret", query: "public search", limit: 3, content: "private", signature: "opaque-signature", apiKey: "plain-api-key", accessKey: "plain-access-key", privateKey: "plain-private-key", sshKey: "plain-ssh-key", sessionKey: "plain-session-key", auth: "plain-auth", passphrase: "plain-passphrase", encryptedContent: "opaque-encrypted", details: { value: "private" }, headers: { "X-Api-Key": "plain-secret-value" } } });
	harness.handlers.get("tool_execution_update")({ toolCallId: "tool-1", toolName: "bash", args: { command: "cat /secret" }, partialResult: { content: [{ type: "text", text: "token=sk-abcdefghijklmnop Authorization: Bearer realtime-secret Cookie: session=cookie-secret at /Users/alice/private result" }] } });
	harness.handlers.get("tool_execution_end")({ toolCallId: "tool-1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "https://user:url-password@example.com token=sk-abcdefghijklmnop at /Users/alice/raw tool failure" }] } });
	harness.handlers.get("message_end")({ message: { role: "toolResult", content: [{ type: "text", text: "raw tool failure" }] } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_start", contentIndex: 4, partial: { content: [{}, {}, {}, {}, { type: "text", text: "" }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_delta", contentIndex: 4, delta: "Authorization: Basic dXNlcjpwYXNz\n", partial: { content: [{}, {}, {}, {}, { type: "text", text: "Authorization: Basic dXNlcjpwYXNz\n" }] } } });
	harness.handlers.get("message_update")({ message: assistantMessage, assistantMessageEvent: { type: "text_end", contentIndex: 4, content: "Authorization: Basic dXNlcjpwYXNz\n", partial: { content: [{}, {}, {}, {}, { type: "text", text: "Authorization: Basic dXNlcjpwYXNz\n" }] } } });
	harness.handlers.get("message_end")({ message: { ...assistantMessage, stopReason: "error", errorMessage: "provider credential leaked", content: [{ type: "text", text: "First answer\n" }, { type: "thinking", thinking: "Safe progress\nTail" }, { type: "thinking", thinking: "MUST_NOT_LEAK", redacted: true }, { type: "toolCall", id: "tool-1", name: "bash", arguments: {} }, { type: "text", text: "Authorization: Basic dXNlcjpwYXNz\n" }] } });
	harness.handlers.get("agent_settled")({});
	const serialized = JSON.stringify(events);
	for (const visible of ["cat /secret", "sk-abcdefghijklmnop", "realtime-secret", "cookie-secret", "url-password", "dXNlcjpwYXNz", "/Users/alice", "opaque-signature", "plain-secret-value", "plain-api-key", "plain-access-key", "plain-private-key", "plain-ssh-key", "plain-session-key", "plain-auth", "plain-passphrase", "opaque-encrypted", "MUST_NOT_LEAK", "eyJhbGci"]) assert.match(serialized, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(serialized, /provider credential leaked/);
	assert.match(serialized, /RUN_FAILED/);
	const parentMessageId = events.find((event) => event.type === "message.started" && event.data.role === "assistant").data.parentMessageId;
	assert.deepEqual(events.find((event) => event.type === "tool.started").data, { toolCallId: "tool-1", parentMessageId, blockIndex: 3, toolName: "bash", status: "running", arguments: { command: "cat /secret", path: "/secret", query: "public search", limit: 3, content: "private", signature: "opaque-signature", apiKey: "plain-api-key", accessKey: "plain-access-key", privateKey: "plain-private-key", sshKey: "plain-ssh-key", sessionKey: "plain-session-key", auth: "plain-auth", passphrase: "plain-passphrase", encryptedContent: "opaque-encrypted", details: { value: "private" }, headers: { "X-Api-Key": "plain-secret-value" } } });
	const reasoning = events.filter((event) => event.type.startsWith("reasoning."));
	assert.deepEqual(reasoning.map((event) => event.type), ["reasoning.started", "reasoning.delta", "reasoning.delta", "reasoning.started", "reasoning.delta", "reasoning.completed", "reasoning.completed"]);
	assert.equal(new Set(reasoning.map((event) => event.data.messageId)).size, 2);
	assert.equal(reasoning[1].data.delta, "Safe progress\nInspect /Us");
	assert.match(reasoning[2].data.delta, /ers\/alice\/private.*eyJhbGci/);
	assert.equal(reasoning[4].data.delta, "MUST_NOT_LEAK");
	const reasoningByBlock = Map.groupBy(reasoning, (event) => event.data.messageId);
	assert.equal(reasoningByBlock.get(`reasoning-${parentMessageId}-1`)?.at(-1)?.data.text, "Safe progress\nTail");
	assert.equal(reasoningByBlock.get(`reasoning-${parentMessageId}-2`)?.at(-1)?.data.text, "MUST_NOT_LEAK");
	const visibleBlocks = events.filter((event) => (event.type === "message.started" || event.type === "reasoning.started") && ["assistant", "reasoning"].includes(event.data.role));
	assert.deepEqual(visibleBlocks.map((event) => [event.data.role, event.data.messageId]), [
		["assistant", `${visibleBlocks[0].data.parentMessageId}-text-0`],
		["reasoning", `reasoning-${visibleBlocks[1].data.parentMessageId}-1`],
		["reasoning", `reasoning-${visibleBlocks[2].data.parentMessageId}-2`],
		["assistant", `${visibleBlocks[3].data.parentMessageId}-text-4`],
	]);
	assert.deepEqual(events.findLast((event) => event.type === "message.completed" && event.data.role === "assistant").data.error, { code: "RUN_FAILED", message: "The assistant run failed" });
});

test("pi-web returns acceptance after send even if the session changes synchronously", async () => {
	let replacement;
	const harness = await loadHarness({ onSend({ handlers }) { handlers.get("session_start")({ reason: "new" }, replacement); } });
	replacement = makeContext({ idle: true, sessionId: "22222222-2222-4222-8222-222222222222" });
	const accepted = harness.adapter.sendUserMessage({ requestId: requestId(4), text: "switch now" });
	assert.equal(accepted.accepted, true);
	assert.equal(accepted.requestId, requestId(4));
});
