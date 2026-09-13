import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import chatCoreModule from "../lib/chat-core.cjs";
import serverModule from "../server/server.cjs";

const { createChatEventHub } = chatCoreModule;
const { createPiWebServer } = serverModule;
const DEFAULT_HOST = process.env.PI_WEB_HOST || "127.0.0.1";
const parsedPort = Number(process.env.PI_WEB_PORT || 8787);
const DEFAULT_PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 8787;
const AUTO_START = process.env.PI_WEB_AUTO_START !== "0";
const MAX_TRACKED_REQUESTS = 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_PENDING_REQUEST_BYTES = 1024 * 1024;

type ChatAcceptance = { accepted: true; requestId: string; delivery: "immediate" | "followUp" };
type PendingRequest = ChatAcceptance & { text: string; wireText: string; bytes: number; enteredInput: boolean };
type SafeError = { code: string; message: string };
type ActiveRun = { runId: string; requestId?: string; abortRequested: boolean; failed: boolean };
type CurrentSessionRecord = { id: string; path: string; cwd: string; name?: string };
type ChatEventInput = Parameters<ReturnType<typeof createChatEventHub>["publish"]>[0];

interface PiWebChatAdapter {
	getSnapshot(): Record<string, unknown>;
	getCurrentSessionRecord(): Promise<CurrentSessionRecord | undefined>;
	sendUserMessage(input: { requestId: string; text: string }): ChatAcceptance;
	abort(input: { sessionId: string; runId: string }): void;
	subscribe(listener: (event: ReturnType<ReturnType<typeof createChatEventHub>["publish"]>) => void): () => void;
}

function codedError(code: string, message: string) {
	return Object.assign(new Error(message), { code });
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("");
}

function messageView(message: unknown) {
	const value = message && typeof message === "object" ? message as Record<string, unknown> : {};
	const role = value.role === "user" || value.role === "assistant" || value.role === "toolResult" ? value.role : "custom";
	return {
		role,
		text: sanitizeToolText(textFromContent(value.content), 32_000),
		status: role === "assistant" && typeof value.stopReason === "string" ? value.stopReason : undefined,
	};
}

function safeFailure(code: string, message: string): SafeError {
	return { code, message };
}

function sanitizeToolText(value: string, maxChars = 4000) {
	return value.slice(0, maxChars);
}

function safeToolArgumentValue(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return sanitizeToolText(value, 500);
	if (!value || typeof value !== "object" || depth >= 4) return undefined;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeToolArgumentValue(item, depth + 1)).filter((item) => item !== undefined);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
		if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || key === "__proto__" || key === "prototype" || key === "constructor") continue;
		const safe = safeToolArgumentValue(item, depth + 1);
		if (safe !== undefined) result[key] = safe;
	}
	return result;
}

function safeToolArguments(args: unknown) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const result = safeToolArgumentValue(args);
	return result && typeof result === "object" && Object.keys(result).length ? result : undefined;
}

function safeToolResult(result: unknown) {
	const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
	const text = sanitizeToolText(textFromContent(value.content));
	return text ? { text } : undefined;
}

function messageEventView(message: unknown) {
	const view = messageView(message);
	if (view.role === "toolResult") return { ...view, text: "Tool result available" };
	if (view.role === "assistant" && view.status === "error") return { ...view, text: "The assistant run failed" };
	return view;
}

export default function piWebExtension(pi: ExtensionAPI) {
	let web: ReturnType<typeof createPiWebServer> | undefined;
	let starting: Promise<void> | undefined;
	let currentCwd = process.cwd();
	let currentSessionId: string | undefined;
	let currentContext: ExtensionContext | undefined;
	let contextGeneration = 0;
	let projectTrusted = false;
	let activeRun: ActiveRun | undefined;
	let terminalError: SafeError | undefined;
	let streamingAssistantMessageId: string | undefined;
	type StreamBlock = { id: string; text: string; publishedChars: number; started: boolean; completed: boolean };
	const streamingText = new Map<number, StreamBlock>();
	const streamingReasoning = new Map<number, StreamBlock>();
	const streamingToolBlocks = new Map<string, { parentMessageId: string; blockIndex: number }>();
	let pendingRequestBytes = 0;
	const requestFifo: PendingRequest[] = [];
	const requestAcceptances = new Map<string, ChatAcceptance>();
	const messageIds = new WeakMap<object, string>();
	const eventHub = createChatEventHub();

	function publish(type: ChatEventInput["type"], data: Record<string, unknown>, identity: { runId?: string; requestId?: string } = {}) {
		if (!currentSessionId) return;
		eventHub.publish({ type, sessionId: currentSessionId, ...identity, data });
	}

	function appendStreamBlock(block: StreamBlock, delta: string) {
		block.text = `${block.text}${delta}`.slice(0, 32_000);
	}

	function publishBlockDelta(type: "message.delta" | "reasoning.delta", block: StreamBlock, parentMessageId: string, blockIndex: number, role: "assistant" | "reasoning", delta: string) {
		block.publishedChars += delta.length;
		publish(type, { messageId: block.id, parentMessageId, blockIndex, role, delta: sanitizeToolText(delta, 32_000) }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	}

	function completeStreamBlock(type: "message.completed" | "reasoning.completed", block: StreamBlock, parentMessageId: string, blockIndex: number, role: "assistant" | "reasoning", finalText?: string, error?: SafeError, force = false) {
		if (block.completed && !force) return;
		block.completed = true;
		if (finalText !== undefined) block.text = finalText.slice(0, 32_000);
		const text = sanitizeToolText(block.text, 32_000);
		publish(type, { messageId: block.id, parentMessageId, blockIndex, role, text, status: error ? "error" : "done", ...(error ? { error } : {}) }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	}

	function rememberAcceptance(acceptance: ChatAcceptance) {
		requestAcceptances.set(acceptance.requestId, acceptance);
		while (requestAcceptances.size > MAX_TRACKED_REQUESTS) requestAcceptances.delete(requestAcceptances.keys().next().value!);
	}

	function removePendingRequest(index: number) {
		const [request] = requestFifo.splice(index, 1);
		if (request) pendingRequestBytes -= request.bytes;
		return request;
	}

	function clearPendingRequests() {
		requestFifo.length = 0;
		pendingRequestBytes = 0;
	}

	function messageId(message: unknown, create: boolean) {
		if (!message || typeof message !== "object") return undefined;
		let id = messageIds.get(message);
		if (!id && create) {
			id = randomUUID();
			messageIds.set(message, id);
		}
		return id;
	}

	function assertCurrentContext() {
		if (!currentSessionId || !currentContext) throw codedError("CHAT_UNAVAILABLE", "Chat runtime is unavailable");
		return { sessionId: currentSessionId, ctx: currentContext, generation: contextGeneration };
	}

	const chatAdapter: PiWebChatAdapter = {
		getSnapshot() {
			const available = Boolean(currentSessionId && currentContext);
			return {
				available,
				currentSessionId,
				sessionName: available ? currentContext!.sessionManager.getSessionName() : undefined,
				cwd: available ? currentCwd : undefined,
				idle: available ? currentContext!.isIdle() : true,
				hasPendingMessages: available ? currentContext!.hasPendingMessages() : false,
				activeRun: activeRun ? { runId: activeRun.runId, requestId: activeRun.requestId, state: "running", abortRequested: activeRun.abortRequested } : null,
				eventCursor: eventHub.cursor,
				capabilities: { send: available, followUp: available, abort: available, steer: false, createSession: false, switchSession: false },
			};
		},
		async getCurrentSessionRecord() {
			const bound = assertCurrentContext();
			const sessionPath = bound.ctx.sessionManager.getSessionFile();
			if (!sessionPath || bound.generation !== contextGeneration || bound.ctx !== currentContext) return undefined;
			return { id: bound.sessionId, path: sessionPath, cwd: currentCwd, name: bound.ctx.sessionManager.getSessionName() };
		},
		sendUserMessage(input) {
			const existing = requestAcceptances.get(input.requestId);
			if (existing) return existing;
			const bound = assertCurrentContext();
			const bytes = Buffer.byteLength(input.text, "utf8");
			if (requestFifo.length >= MAX_PENDING_REQUESTS || pendingRequestBytes + bytes > MAX_PENDING_REQUEST_BYTES) {
				throw codedError("CHAT_QUEUE_FULL", "Too many pending Web chat requests");
			}
			const delivery = bound.ctx.isIdle() ? "immediate" : "followUp";
			const acceptance: ChatAcceptance = { accepted: true, requestId: input.requestId, delivery };
			const wireText = `\u2063pi-web:${input.requestId}\u2063${input.text}`;
			requestFifo.push({ ...acceptance, text: input.text, wireText, bytes, enteredInput: false });
			pendingRequestBytes += bytes;
			rememberAcceptance(acceptance);
			try {
				pi.sendUserMessage(wireText, delivery === "followUp"
					? { deliverAs: "followUp", expandPromptTemplates: false }
					: { expandPromptTemplates: false });
			} catch (error) {
				removePendingRequest(requestFifo.findIndex((request) => request.requestId === input.requestId));
				requestAcceptances.delete(input.requestId);
				throw error;
			}
			// sendUserMessage is a void dispatch API. Once invoked, report acceptance even
			// if a synchronous lifecycle callback replaced the session; session.changed is
			// the authoritative signal and clients must not be encouraged to retry.
			if (bound.generation === contextGeneration && bound.ctx === currentContext) {
				publish("request.accepted", { accepted: true, delivery, state: delivery === "immediate" ? "accepted" : "queued" }, { requestId: input.requestId });
			}
			return acceptance;
		},
		abort(input) {
			const bound = assertCurrentContext();
			if (input.sessionId !== bound.sessionId || !activeRun || input.runId !== activeRun.runId) throw codedError("RUN_CHANGED", "The active run has changed");
			activeRun.abortRequested = true;
			bound.ctx.abort();
			if (bound.generation !== contextGeneration || bound.ctx !== currentContext) throw codedError("SESSION_CHANGED", "Session changed while requesting abort");
			publish("run.abort_requested", { state: "running" }, { runId: activeRun.runId, requestId: activeRun.requestId });
		},
		subscribe(listener) { return eventHub.subscribe(listener); },
	};

	function makeServer() {
		const options: NonNullable<Parameters<typeof createPiWebServer>[0]> & { chatAdapter: PiWebChatAdapter; eventHub: typeof eventHub } = {
			host: DEFAULT_HOST,
			port: DEFAULT_PORT,
			cwd: currentCwd,
			agentDir: path.join(os.homedir(), ".pi", "agent"),
			projectTrusted,
			listSessions: () => SessionManager.listAll(),
			listEffectiveSkills: () => pi.getCommands().filter((command) => command.source === "skill"),
			getCurrentSessionId: () => currentSessionId,
			renameSession: (session, name, current) => {
				if (current) pi.setSessionName(name);
				else SessionManager.open(session.path).appendSessionInfo(name);
			},
			chatAdapter,
			eventHub,
		};
		return createPiWebServer(options);
	}

	async function start(ctx?: ExtensionCommandContext) {
		if (web?.address()) return web.address();
		if (!starting) {
			starting = (async () => {
				web = makeServer();
				try { await web.start(); }
				catch (error) { web = undefined; throw error; }
			})().finally(() => { starting = undefined; });
		}
		await starting;
		const address = web?.address();
		if (ctx && address) ctx.ui.notify(`Pi Web: ${address.url}`, "info");
		return address;
	}

	async function stop(ctx?: ExtensionCommandContext) {
		if (starting) await starting.catch(() => {});
		await web?.stop();
		web = undefined;
		ctx?.ui.setStatus("pi-web", undefined);
		ctx?.ui.notify("Pi Web stopped", "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		const previousSessionId = currentSessionId;
		contextGeneration++;
		currentContext = ctx;
		currentCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionId();
		projectTrusted = ctx.isProjectTrusted();
		activeRun = undefined;
		terminalError = undefined;
		streamingAssistantMessageId = undefined;
		clearPendingRequests();
		requestAcceptances.clear();
		publish("session.changed", { previousSessionId, currentSessionId, available: true, reason: _event.reason });
		if (!AUTO_START) return;
		try {
			const address = await start();
			if (address && ctx.hasUI) ctx.ui.setStatus("pi-web", `web :${address.port}`);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Pi Web failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_info_changed", (event) => {
		publish("snapshot", { ...chatAdapter.getSnapshot(), sessionName: event.name });
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") return;
		// The one-use wire marker prevents another extension's input from claiming a
		// Web request. Its requestId also disambiguates identical user text.
		const request = requestFifo.find((candidate) => !candidate.enteredInput && candidate.wireText === event.text);
		if (!request) return;
		request.enteredInput = true;
		return { action: "transform" as const, text: request.text };
	});

	pi.on("agent_start", () => {
		const requestIndex = requestFifo.findIndex((request) => request.enteredInput);
		const request = requestIndex < 0 ? undefined : removePendingRequest(requestIndex);
		// Pi may start retries/compaction and queued follow-ups before one final
		// agent_settled. Keep one operation id for that lifecycle, while each
		// consumed Web request starts a new request span for browser correlation.
		if (activeRun && !request) return;
		if (activeRun && request) {
			activeRun = { runId: activeRun.runId, requestId: request.requestId, abortRequested: false, failed: false };
		} else {
			activeRun = { runId: randomUUID(), requestId: request?.requestId, abortRequested: false, failed: false };
		}
		terminalError = undefined;
		publish("run.started", { state: "running" }, { runId: activeRun.runId, requestId: activeRun.requestId });
	});

	pi.on("message_start", (event) => {
		const view = messageEventView(event.message);
		const id = messageId(event.message, true)!;
		if (view.role === "assistant") {
			streamingAssistantMessageId = id;
			streamingText.clear();
			streamingReasoning.clear();
			streamingToolBlocks.clear();
			return;
		}
		publish("message.started", { messageId: id, role: view.role, text: view.text }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	});

	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent;
		const assistantId = streamingAssistantMessageId ?? messageId(event.message, true)!;
		if (update.type === "text_start" || update.type === "text_delta" || update.type === "text_end") {
			const contentIndex = Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
			const block = streamingText.get(contentIndex) ?? { id: `${assistantId}-text-${contentIndex}`, text: "", publishedChars: 0, started: false, completed: false };
			streamingText.set(contentIndex, block);
			if (!block.started) {
				publish("message.started", { messageId: block.id, parentMessageId: assistantId, blockIndex: contentIndex, role: "assistant", text: "" }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
				block.started = true;
			}
			if (update.type === "text_delta") {
				appendStreamBlock(block, update.delta);
				publishBlockDelta("message.delta", block, assistantId, contentIndex, "assistant", update.delta);
			} else if (update.type === "text_end") {
				completeStreamBlock("message.completed", block, assistantId, contentIndex, "assistant", update.content);
			}
			return;
		}
		if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
			const contentIndex = Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
			const partialPart = update.partial.content[contentIndex];
			const toolCallId = update.type === "toolcall_end" ? update.toolCall.id : partialPart?.type === "toolCall" ? partialPart.id : undefined;
			if (typeof toolCallId === "string") streamingToolBlocks.set(toolCallId, { parentMessageId: assistantId, blockIndex: contentIndex });
			return;
		}
		if (update.type !== "thinking_start" && update.type !== "thinking_delta" && update.type !== "thinking_end") return;
		const contentIndex = Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
		const block = streamingReasoning.get(contentIndex) ?? { id: `reasoning-${assistantId}-${contentIndex}`, text: "", publishedChars: 0, started: false, completed: false };
		streamingReasoning.set(contentIndex, block);
		if (!block.started) {
			publish("reasoning.started", { messageId: block.id, parentMessageId: assistantId, blockIndex: contentIndex, role: "reasoning", text: "" }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
			block.started = true;
		}
		if (update.type === "thinking_delta") {
			appendStreamBlock(block, update.delta);
			publishBlockDelta("reasoning.delta", block, assistantId, contentIndex, "reasoning", update.delta);
		} else if (update.type === "thinking_end") {
			block.text = update.content.slice(0, 32_000);
		}
	});

	pi.on("message_end", (event) => {
		const view = messageEventView(event.message);
		const value = event.message as unknown as Record<string, unknown>;
		if (view.role === "assistant" && (value.stopReason === "error" || value.stopReason === "aborted")) {
			if (value.stopReason === "error") {
				activeRun && (activeRun.failed = true);
				terminalError = safeFailure("RUN_FAILED", "The assistant run failed");
			}
			if (value.stopReason === "aborted" && activeRun) activeRun.abortRequested = true;
		}
		const id = view.role === "assistant" && streamingAssistantMessageId ? streamingAssistantMessageId : messageId(event.message, true)!;
		if (view.role === "assistant") {
			const failure = view.status === "error" ? safeFailure("RUN_FAILED", "The assistant run failed") : undefined;
			const content = Array.isArray(value.content) ? value.content : [];
			const finalTextIndexes = new Set<number>();
			const finalReasoningIndexes = new Set<number>();
			content.forEach((part, blockIndex) => {
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") finalTextIndexes.add(blockIndex);
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "thinking") finalReasoningIndexes.add(blockIndex);
			});
			for (const [blockIndex, block] of streamingText) if (!finalTextIndexes.has(blockIndex) && block.started && (!block.completed || block.text)) completeStreamBlock("message.completed", block, id, blockIndex, "assistant", "", undefined, true);
			for (const [blockIndex, block] of streamingReasoning) if (!finalReasoningIndexes.has(blockIndex) && block.started && (!block.completed || block.text)) completeStreamBlock("reasoning.completed", block, id, blockIndex, "reasoning", "", undefined, true);
			content.forEach((part, blockIndex) => {
				if (!part || typeof part !== "object") return;
				const blockValue = part as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown };
				if (blockValue.type === "text" && typeof blockValue.text === "string") {
					const block = streamingText.get(blockIndex) ?? { id: `${id}-text-${blockIndex}`, text: "", publishedChars: 0, started: false, completed: false };
					streamingText.set(blockIndex, block);
					if (!block.started) { publish("message.started", { messageId: block.id, parentMessageId: id, blockIndex, role: "assistant", text: "" }, { runId: activeRun?.runId, requestId: activeRun?.requestId }); block.started = true; }
					if (!block.completed || block.text !== blockValue.text) completeStreamBlock("message.completed", block, id, blockIndex, "assistant", blockValue.text, undefined, true);
				} else if (blockValue.type === "thinking" && typeof blockValue.thinking === "string") {
					const block = streamingReasoning.get(blockIndex) ?? { id: `reasoning-${id}-${blockIndex}`, text: "", publishedChars: 0, started: false, completed: false };
					streamingReasoning.set(blockIndex, block);
					if (!block.started) { publish("reasoning.started", { messageId: block.id, parentMessageId: id, blockIndex, role: "reasoning", text: "" }, { runId: activeRun?.runId, requestId: activeRun?.requestId }); block.started = true; }
					if (!block.completed || block.text !== blockValue.thinking) completeStreamBlock("reasoning.completed", block, id, blockIndex, "reasoning", blockValue.thinking, undefined, true);
				} else if (blockValue.type === "toolCall" && typeof blockValue.id === "string") {
					streamingToolBlocks.set(blockValue.id, { parentMessageId: id, blockIndex });
				}
			});
			for (const [blockIndex, block] of streamingReasoning) if (block.started && !block.completed) completeStreamBlock("reasoning.completed", block, id, blockIndex, "reasoning");
			for (const [blockIndex, block] of streamingText) if (block.started && !block.completed) completeStreamBlock("message.completed", block, id, blockIndex, "assistant", undefined, failure);
			const lastText = [...streamingText.entries()].at(-1);
			if (failure && lastText?.[1].completed) publish("message.completed", { messageId: lastText[1].id, parentMessageId: id, blockIndex: lastText[0], role: "assistant", text: sanitizeToolText(lastText[1].text, 32_000), status: "error", error: failure }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
			if (streamingText.size === 0 && (view.text || failure)) publish("message.completed", { messageId: id, role: view.role, text: view.text, status: view.status, ...(failure ? { error: failure } : {}) }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
			streamingAssistantMessageId = undefined;
			streamingText.clear();
			streamingReasoning.clear();
			return;
		}
		publish("message.completed", { messageId: id, role: view.role, text: view.text, status: view.status }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	});

	pi.on("tool_execution_start", (event) => {
		const position = streamingToolBlocks.get(event.toolCallId);
		publish("tool.started", { toolCallId: event.toolCallId, ...position, toolName: event.toolName, status: "running", arguments: safeToolArguments(event.args) }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	});

	pi.on("tool_execution_update", (event) => {
		const position = streamingToolBlocks.get(event.toolCallId);
		publish("tool.updated", { toolCallId: event.toolCallId, ...position, toolName: event.toolName, status: "running", arguments: safeToolArguments(event.args), result: safeToolResult(event.partialResult) }, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	});

	pi.on("tool_execution_end", (event) => {
		const position = streamingToolBlocks.get(event.toolCallId);
		publish("tool.completed", {
			toolCallId: event.toolCallId,
			...position,
			toolName: event.toolName,
			status: event.isError ? "error" : "done",
			arguments: safeToolArguments(event.args),
			result: safeToolResult(event.result),
			error: event.isError ? safeFailure("TOOL_FAILED", "Tool execution failed") : undefined,
		}, { runId: activeRun?.runId, requestId: activeRun?.requestId });
	});

	pi.on("agent_settled", () => {
		if (!activeRun) return;
		const settled = activeRun;
		const state = settled.abortRequested ? "killed" : settled.failed ? "failed" : "done";
		publish("run.settled", { state, error: terminalError, historyRevision: Date.now() }, { runId: settled.runId, requestId: settled.requestId });
		activeRun = undefined;
		terminalError = undefined;
		streamingAssistantMessageId = undefined;
		streamingText.clear();
		streamingReasoning.clear();
		streamingToolBlocks.clear();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const shuttingDownSessionId = currentSessionId;
		if (shuttingDownSessionId) publish("session.changed", { previousSessionId: shuttingDownSessionId, available: false, reason: event.reason });
		contextGeneration++;
		currentContext = undefined;
		currentSessionId = undefined;
		activeRun = undefined;
		terminalError = undefined;
		streamingAssistantMessageId = undefined;
		clearPendingRequests();
		requestAcceptances.clear();
		ctx.ui.setStatus("pi-web", undefined);
		await stop();
	});

	pi.registerCommand("web", {
		description: "Manage the local Pi Web Control Deck (start|stop|status|open)",
		getArgumentCompletions: (prefix) => ["start", "stop", "status", "open"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "open";
			if (action === "stop") return stop(ctx);
			if (action === "status") {
				const address = web?.address();
				ctx.ui.notify(address ? `Pi Web running: ${address.url}` : "Pi Web is stopped", address ? "info" : "warning");
				return;
			}
			if (action === "start" || action === "open") {
				const address = await start(ctx);
				if (address) ctx.ui.setStatus("pi-web", `web :${address.port}`);
				return;
			}
			ctx.ui.notify("Usage: /web [start|stop|status|open]", "warning");
		},
	});
}
