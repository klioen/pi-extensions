export type RunState = "queued" | "running" | "done" | "killed" | "failed";
export type ChatEventType =
	| "snapshot"
	| "session.changed"
	| "request.accepted"
	| "run.started"
	| "message.started"
	| "message.delta"
	| "message.completed"
	| "reasoning.started"
	| "reasoning.delta"
	| "reasoning.completed"
	| "tool.started"
	| "tool.updated"
	| "tool.completed"
	| "run.abort_requested"
	| "run.settled"
	| "stream.reset"
	| "runtime.error";

export interface ChatMessageInput { requestId: string; sessionId: string; text: string }
export interface ChatAcceptance { accepted: true; requestId: string; delivery: "immediate" | "followUp" }
export interface ChatEventEnvelope {
	id: number;
	type: ChatEventType;
	timestamp: number;
	sessionId: string;
	runId?: string;
	requestId?: string;
	data: Record<string, unknown>;
}
export interface ChatEventInput {
	type: ChatEventType;
	timestamp?: number;
	sessionId: string;
	runId?: string;
	requestId?: string;
	data?: unknown;
}
export interface EventReplay {
	reset: boolean;
	reason?: "SSE_REPLAY_EXPIRED";
	cursor: number;
	events: ChatEventEnvelope[];
}
export interface ChatEventHub {
	readonly cursor: number;
	readonly size: number;
	publish(event: ChatEventInput): ChatEventEnvelope;
	replay(afterId?: number): EventReplay;
	subscribe(listener: (event: ChatEventEnvelope) => void): () => void;
	clear(): void;
}
export interface RequestIdempotencyCache<T> {
	readonly size: number;
	has(requestId: string): boolean;
	get(requestId: string): T | undefined;
	set(requestId: string, value: T): T;
	delete(requestId: string): boolean;
	clear(): void;
	getOrCreate(requestId: string, create: () => T): { duplicate: boolean; value: T };
}
export interface RunStateMachine {
	readonly state: RunState;
	transition(next: RunState): RunState;
	isTerminal(): boolean;
}

export class ChatCoreError extends Error {
	readonly code: string;
	readonly field?: string;
	readonly details?: unknown;
	constructor(code: string, message: string, options?: { field?: string; details?: unknown });
}

export const CHAT_LIMITS: Readonly<{
	maxMessageBytes: number;
	maxEventBytes: number;
	maxEventStringBytes: number;
	maxEventDepth: number;
	maxArrayItems: number;
	maxObjectKeys: number;
	maxReplayEvents: number;
	replayMaxAgeMs: number;
	maxRequestEntries: number;
	requestTtlMs: number;
}>;
export const RUN_STATES: readonly RunState[];
export function validateChatMessageInput(input: unknown, options?: { maxMessageBytes?: number }): ChatMessageInput;
export function transitionRunState(current: RunState, next: RunState): RunState;
export function createRunStateMachine(initialState?: RunState): RunStateMachine;
export function createRequestIdempotencyCache<T>(options?: { maxEntries?: number; ttlMs?: number; now?: () => number }): RequestIdempotencyCache<T>;
export function sanitizeEventData(type: ChatEventType, data: unknown, options?: { maxStringBytes?: number; maxDepth?: number; maxArrayItems?: number; maxObjectKeys?: number }): Record<string, unknown>;
export function createSafeEventEnvelope(event: ChatEventEnvelope, options?: { maxEventBytes?: number; maxStringBytes?: number; maxDepth?: number; maxArrayItems?: number; maxObjectKeys?: number }): ChatEventEnvelope;
export function createChatEventHub(options?: { maxEvents?: number; maxAgeMs?: number; now?: () => number; envelopeOptions?: { maxEventBytes?: number; maxStringBytes?: number; maxDepth?: number; maxArrayItems?: number; maxObjectKeys?: number } }): ChatEventHub;
