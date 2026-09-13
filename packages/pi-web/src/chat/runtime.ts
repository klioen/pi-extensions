import { historyMessages, mergePendingMessages, reduceChatEvent } from "./reducer";
import type { ChatAcceptance, ChatEventEnvelope, ChatHistory, ChatMessage, ChatSnapshot, ChatState } from "./types";

export const CHAT_EVENT_TYPES = [
  "snapshot", "session.changed", "request.accepted", "run.started", "message.started",
  "message.delta", "message.completed", "reasoning.started", "reasoning.delta", "reasoning.completed",
  "tool.started", "tool.updated", "tool.completed",
  "run.abort_requested", "run.settled", "stream.reset", "runtime.error",
] as const;
export const MAX_EVENT_BUFFER = 512;
const MAX_PENDING_REQUESTS = 256;
const MAX_RETRY_DELAY = 30_000;

export class ChatHttpError extends Error {
  readonly status?: number;
  readonly code?: string;
  preserveDraft?: boolean;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ChatHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ChatRequestOptions extends RequestInit { body?: string }
export type ChatRequest = (path: string, options?: ChatRequestOptions) => Promise<unknown>;
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ChatRuntimeOptions {
  onChange?: (state: ChatState) => void;
  request?: ChatRequest;
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSourceLike;
  randomUUID?: () => string;
}

async function defaultRequest<T>(requestFetch: typeof fetch, path: string, options: ChatRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await requestFetch(path, { ...options, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string; code?: string };
  if (!response.ok) throw new ChatHttpError(payload.error || payload.message || `HTTP ${response.status}`, response.status, payload.code);
  return payload as T;
}

export class ChatRuntime {
  onChange: (state: ChatState) => void;
  generation = 0;
  eventSource: EventSourceLike | null = null;
  resetTimer: ReturnType<typeof setTimeout> | null = null;
  syncInFlight: Promise<void> | null = null;
  syncRequested = false;
  retryAttempt = 0;
  buffering = false;
  bufferOverflow = false;
  eventBuffer: ChatEventEnvelope[] = [];
  destroyed = false;
  state: ChatState;
  private readonly request: ChatRequest;
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly randomUUID: () => string;

  constructor(options: ChatRuntimeOptions = {}) {
    this.onChange = options.onChange || (() => undefined);
    const requestFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.request = options.request ?? ((path, requestOptions) => {
      if (!requestFetch) return Promise.reject(new ChatHttpError("Fetch is unavailable"));
      return defaultRequest(requestFetch, path, requestOptions);
    });
    this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url));
    this.randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
    this.state = {
      phase: "loading", connected: false, available: false, snapshot: null,
      sessionId: "", messages: [], activeRun: null, pendingRequests: new Map(), error: "",
    };
  }

  start(): Promise<void> { return this.sync(); }
  emit(): void { if (!this.destroyed) this.onChange(this.state); }

  sync(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.syncInFlight) {
      this.syncRequested = true;
      return this.syncInFlight;
    }
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.syncInFlight = this.performSync().finally(() => {
      this.syncInFlight = null;
      if (this.syncRequested && !this.destroyed) {
        this.syncRequested = false;
        this.scheduleSync(0);
      }
    });
    return this.syncInFlight;
  }

  async performSync(): Promise<void> {
    const generation = ++this.generation;
    this.closeStream();
    this.state.phase = "loading";
    this.state.connected = false;
    this.state.error = "";
    this.emit();
    try {
      const snapshot = await this.request("/api/chat/snapshot") as ChatSnapshot;
      if (!this.isCurrent(generation)) return;
      this.state.snapshot = snapshot;
      this.state.available = snapshot.available === true;
      this.state.sessionId = snapshot.currentSessionId || "";
      this.state.activeRun = snapshot.activeRun || null;
      if (!this.state.available || !this.state.sessionId) {
        this.retryAttempt = 0;
        this.state.phase = "unavailable";
        this.state.messages = [];
        this.emit();
        return;
      }

      this.buffering = true;
      this.bufferOverflow = false;
      this.eventBuffer = [];
      this.openStream(snapshot.eventCursor || 0, generation);
      const history = await this.request("/api/chat/history") as ChatHistory;
      if (!this.isCurrent(generation)) return;
      if (history.sessionId !== this.state.sessionId) {
        this.syncRequested = true;
        return;
      }
      if (this.bufferOverflow) {
        this.buffering = false;
        this.eventBuffer = [];
        this.syncRequested = true;
        return;
      }
      this.state.messages = mergePendingMessages(historyMessages(history.entries), this.state.pendingRequests);
      this.buffering = false;
      const buffered = this.eventBuffer.splice(0).sort((a, b) => a.id - b.id);
      for (const event of buffered) this.applyEvent(event, generation);
      this.retryAttempt = 0;
      this.state.phase = "ready";
      this.emit();
    } catch (caught) {
      if (!this.isCurrent(generation)) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.buffering = false;
      this.eventBuffer = [];
      this.state.phase = error instanceof ChatHttpError && error.code === "CHAT_UNAVAILABLE" ? "unavailable" : "error";
      this.state.error = error.message;
      this.state.connected = false;
      this.emit();
      this.scheduleRetry();
    }
  }

  isCurrent(generation: number): boolean { return !this.destroyed && generation === this.generation; }

  openStream(cursor: number, generation: number): void {
    const source = this.createEventSource(`/api/chat/events?lastEventId=${encodeURIComponent(cursor)}`);
    this.eventSource = source;
    source.onopen = () => {
      if (!this.isCurrent(generation)) return;
      this.state.connected = true;
      this.emit();
    };
    source.onerror = () => {
      if (!this.isCurrent(generation)) return;
      this.state.connected = false;
      this.emit();
      this.scheduleSync(800);
    };
    for (const type of CHAT_EVENT_TYPES) source.addEventListener(type, (raw) => {
      if (!this.isCurrent(generation)) return;
      let event: ChatEventEnvelope;
      try { event = JSON.parse(raw.data) as ChatEventEnvelope; } catch { return; }
      if (type === "stream.reset" || type === "session.changed") {
        this.scheduleSync();
        return;
      }
      if (event.sessionId !== this.state.sessionId) return;
      if (this.buffering) {
        if (this.eventBuffer.length >= MAX_EVENT_BUFFER) {
          this.bufferOverflow = true;
          this.eventBuffer = [];
          this.closeStream();
        } else if (!this.bufferOverflow) this.eventBuffer.push(event);
      } else this.applyEvent(event, generation);
    });
  }

  applyEvent(event: ChatEventEnvelope, generation = this.generation): void {
    if (!this.isCurrent(generation) || event.sessionId !== this.state.sessionId) return;
    this.state = reduceChatEvent(this.state, event);
    if (event.type === "run.settled") this.scheduleSync(0);
    this.emit();
  }

  async send(text: string): Promise<ChatAcceptance> {
    const requestId = this.randomUUID();
    const sessionId = this.state.sessionId;
    const pending = { requestId, text, status: "sending" as const, createdAt: Date.now() };
    const optimistic: ChatMessage = { id: `request-${requestId}`, role: "user", text, status: "sending", requestId };
    this.state.pendingRequests.set(requestId, pending);
    this.state.messages.push(optimistic);
    this.prunePendingRequests();
    this.emit();
    try {
      const acceptance = await this.request("/api/chat/messages", {
        method: "POST", body: JSON.stringify({ requestId, sessionId, text }),
      }) as ChatAcceptance;
      if (sessionId !== this.state.sessionId) throw new ChatHttpError("Current session changed", 409, "SESSION_CHANGED");
      const nextStatus = acceptance.delivery === "followUp" ? "queued" : "accepted";
      if (this.state.pendingRequests.get(requestId)?.status === "sending") this.updateRequestStatus(requestId, nextStatus);
      this.emit();
      return acceptance;
    } catch (caught) {
      const error = caught instanceof ChatHttpError ? caught : new ChatHttpError(caught instanceof Error ? caught.message : String(caught));
      this.state.pendingRequests.delete(requestId);
      const message = this.state.messages.find((item) => item.requestId === requestId);
      if (error.status === 409 || error.code === "SESSION_CHANGED") {
        if (message) this.state.messages.splice(this.state.messages.indexOf(message), 1);
        error.preserveDraft = true;
        this.scheduleSync();
      } else if (message) {
        message.status = "failed";
        message.error = error.message;
      }
      this.emit();
      throw error;
    }
  }

  private updateRequestStatus(requestId: string, status: ChatMessage["status"]): void {
    const pending = this.state.pendingRequests.get(requestId);
    if (pending) pending.status = status;
    const message = this.state.messages.find((item) => item.requestId === requestId);
    if (message && message.status !== "done") message.status = status;
  }

  private prunePendingRequests(terminalRequestId?: string): void {
    if (terminalRequestId) this.state.pendingRequests.delete(terminalRequestId);
    while (this.state.pendingRequests.size > MAX_PENDING_REQUESTS) {
      const oldest = this.state.pendingRequests.keys().next().value as string | undefined;
      if (!oldest) break;
      this.state.pendingRequests.delete(oldest);
    }
  }

  async abort(): Promise<void> {
    const run = this.state.activeRun;
    if (!run?.runId) return;
    try {
      await this.request("/api/chat/abort", {
        method: "POST", body: JSON.stringify({ sessionId: this.state.sessionId, runId: run.runId }),
      });
    } catch (caught) {
      const error = caught instanceof ChatHttpError ? caught : new ChatHttpError(caught instanceof Error ? caught.message : String(caught));
      if (error.status === 409) this.scheduleSync();
      throw error;
    }
  }

  scheduleRetry(): void {
    const delay = Math.min(MAX_RETRY_DELAY, 500 * (2 ** Math.min(this.retryAttempt++, 6)));
    this.scheduleSync(delay);
  }

  scheduleSync(delay = 0): void {
    if (this.destroyed) return;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      void this.sync();
    }, delay);
  }

  closeStream(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.generation++;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.syncRequested = false;
    this.closeStream();
    this.onChange = () => undefined;
  }
}

export { ChatRuntime as Runtime };
