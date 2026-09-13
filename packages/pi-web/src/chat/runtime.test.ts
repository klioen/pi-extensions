import { describe, expect, it, vi } from "vitest";
import { ChatHttpError, ChatRuntime, MAX_EVENT_BUFFER, type EventSourceLike } from "./runtime";
import type { ChatEventEnvelope } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  dispatch(type: string, event: ChatEventEnvelope) { this.listeners.get(type)?.({ data: JSON.stringify(event) } as MessageEvent<string>); }
}

describe("ChatRuntime", () => {
  it("subscribes to safe reasoning lifecycle events", () => {
    const source = new FakeEventSource();
    const runtime = new ChatRuntime({ createEventSource: () => source });
    runtime.state.sessionId = "session-1";
    runtime.openStream(0, runtime.generation);
    expect(source.listeners.has("reasoning.started")).toBe(true);
    expect(source.listeners.has("reasoning.completed")).toBe(true);
    expect(source.listeners.has("reasoning.delta")).toBe(true);
  });

  it("installs optimistic state before POST settles and reconciles pre-ack SSE", async () => {
    const post = deferred<{ delivery: "immediate" }>();
    const runtime = new ChatRuntime({ request: () => post.promise, randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    runtime.state.sessionId = "session-1";
    const sending = runtime.send("hello");
    expect(runtime.state.pendingRequests.size).toBe(1);
    const requestId = runtime.state.messages[0].requestId;
    runtime.applyEvent({ id: 1, type: "message.started", sessionId: "session-1", requestId, data: { messageId: "user-1", role: "user", text: "hello" } });
    post.resolve({ delivery: "immediate" });
    await sending;
    expect(runtime.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(runtime.state.messages[0]).toEqual(expect.objectContaining({ id: "user-1", status: "accepted" }));
  });

  it("does not downgrade a request when run.started arrives before the POST response", async () => {
    const post = deferred<{ delivery: "followUp" }>();
    const runtime = new ChatRuntime({ request: () => post.promise, randomUUID: () => "00000000-0000-4000-8000-000000000002" });
    runtime.state.sessionId = "session-1";
    const sending = runtime.send("hello");
    const requestId = runtime.state.messages[0].requestId;
    runtime.applyEvent({ id: 1, type: "run.started", sessionId: "session-1", runId: "run-1", requestId, data: { state: "running" } });
    post.resolve({ delivery: "followUp" });
    await sending;
    expect(runtime.state.pendingRequests.get(requestId! as string)?.status).toBe("running");
    expect(runtime.state.messages[0].status).toBe("running");
  });

  it("cleans optimistic state on conflict and marks other failures", async () => {
    for (const status of [409, 500]) {
      const runtime = new ChatRuntime({ request: () => Promise.reject(new ChatHttpError(`HTTP ${status}`, status, status === 409 ? "SESSION_CHANGED" : "FAILED")), randomUUID: () => String(status) });
      runtime.state.sessionId = "session-1";
      await expect(runtime.send("keep me")).rejects.toMatchObject(status === 409 ? { preserveDraft: true } : {});
      expect(runtime.state.pendingRequests.size).toBe(0);
      if (status === 409) expect(runtime.state.messages).toHaveLength(0);
      else expect(runtime.state.messages[0].status).toBe("failed");
      runtime.destroy();
    }
  });

  it("treats history read failures as retryable errors rather than missing runtime", async () => {
    const runtime = new ChatRuntime({
      request: (path) => path.endsWith("snapshot")
        ? Promise.resolve({ available: true, currentSessionId: "s1" })
        : Promise.reject(new ChatHttpError("Chat history is unavailable", 503, "CHAT_HISTORY_UNAVAILABLE")),
      createEventSource: () => new FakeEventSource(),
    });
    runtime.scheduleRetry = vi.fn();
    await runtime.performSync();
    expect(runtime.state.phase).toBe("error");
    expect(runtime.state.available).toBe(true);
    expect(runtime.scheduleRetry).toHaveBeenCalledOnce();
  });

  it("uses bounded exponential retry delays", async () => {
    const runtime = new ChatRuntime({ request: () => Promise.reject(new Error("offline")) });
    const delays: number[] = [];
    runtime.scheduleSync = (delay = 0) => { delays.push(delay); };
    await runtime.performSync();
    await runtime.performSync();
    expect(delays).toEqual([500, 1000]);
    runtime.retryAttempt = 100;
    runtime.scheduleRetry();
    expect(delays.at(-1)).toBe(30000);
  });

  it("bounds the initial fence and forces resync after overflow", () => {
    const source = new FakeEventSource();
    const runtime = new ChatRuntime({ createEventSource: () => source });
    runtime.state.sessionId = "session-1";
    runtime.buffering = true;
    runtime.openStream(0, runtime.generation);
    for (let id = 1; id <= MAX_EVENT_BUFFER + 1; id++) source.dispatch("message.delta", { id, type: "message.delta", sessionId: "session-1", data: { messageId: "m1", delta: "x" } });
    expect(runtime.eventBuffer).toHaveLength(0);
    expect(runtime.bufferOverflow).toBe(true);
    expect(source.closed).toBe(true);
  });

  it("fences snapshot, stream events, and authoritative history", async () => {
    const history = deferred<{ sessionId: string; entries: [] }>();
    const source = new FakeEventSource();
    const request = vi.fn((path: string) => path.endsWith("snapshot")
      ? Promise.resolve({ available: true, currentSessionId: "s1", eventCursor: 7 })
      : history.promise);
    const runtime = new ChatRuntime({ request, createEventSource: () => source });
    const syncing = runtime.performSync();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    source.dispatch("message.delta", { id: 8, type: "message.delta", sessionId: "s1", data: { messageId: "m1", delta: "hi" } });
    history.resolve({ sessionId: "s1", entries: [] });
    await syncing;
    expect(runtime.state.messages[0].text).toBe("hi");
    expect(runtime.state.phase).toBe("ready");
    expect(runtime.state.connected).toBe(false);
    source.onopen?.(new Event("open"));
    expect(runtime.state.connected).toBe(true);
  });

  it.each(["running", "queued"] as const)("does not resurrect earlier optimistic requests after an operation settles with the last span %s", async (lastStatus) => {
    const request = vi.fn((path: string) => path.endsWith("snapshot")
      ? Promise.resolve({ available: true, currentSessionId: "s1" })
      : Promise.resolve({ sessionId: "s1", entries: [] }));
    const runtime = new ChatRuntime({ request, createEventSource: () => new FakeEventSource() });
    runtime.state.sessionId = "s1";
    runtime.state.activeRun = { runId: "run-1", requestId: "r2", state: "running" };
    for (const [requestId, status] of [["r1", "running"], ["r2", lastStatus]] as const) {
      runtime.state.pendingRequests.set(requestId, { requestId, text: requestId, status, createdAt: 1 });
      runtime.state.messages.push({ id: `request-${requestId}`, role: "user", text: requestId, status, requestId });
    }
    runtime.scheduleSync = vi.fn();

    runtime.applyEvent({ id: 3, type: "run.settled", sessionId: "s1", runId: "run-1", requestId: "r2", data: { state: "done" } });
    await runtime.performSync();

    expect(runtime.state.pendingRequests.size).toBe(0);
    expect(runtime.state.messages).toHaveLength(0);
  });

  it("restores pending optimistic messages after history replacement without duplicating authoritative requestIds", async () => {
    const request = vi.fn((path: string) => path.endsWith("snapshot")
      ? Promise.resolve({ available: true, currentSessionId: "s1" })
      : Promise.resolve({
          sessionId: "s1",
          entries: [
            { id: "history-r1", role: "user", content: "already persisted", requestId: "r1" },
            { id: "assistant-1", role: "assistant", content: "reply" },
          ],
        }));
    const runtime = new ChatRuntime({ request, createEventSource: () => new FakeEventSource() });
    runtime.state.sessionId = "s1";
    for (const [requestId, status] of [["r1", "queued"], ["r2", "sending"], ["r3", "running"]] as const) {
      runtime.state.pendingRequests.set(requestId, { requestId, text: requestId, status, createdAt: 1 });
      runtime.state.messages.push({ id: `request-${requestId}`, role: "user", text: requestId, status, requestId });
    }

    await runtime.performSync();

    expect(runtime.state.messages.filter((message) => message.requestId === "r1")).toHaveLength(1);
    expect(runtime.state.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "history-r1", requestId: "r1", status: "done" }),
      expect.objectContaining({ requestId: "r2", status: "sending", text: "r2" }),
      expect.objectContaining({ requestId: "r3", status: "running", text: "r3" }),
    ]));
  });

  it("closes streams, clears timers, and ignores late async work on destroy", async () => {
    vi.useFakeTimers();
    const snapshot = deferred<{ available: boolean; currentSessionId: string }>();
    const source = new FakeEventSource();
    const onChange = vi.fn();
    const runtime = new ChatRuntime({ request: () => snapshot.promise, createEventSource: () => source, onChange });
    const syncing = runtime.performSync();
    runtime.openStream(0, runtime.generation);
    runtime.scheduleSync(100);
    runtime.destroy();
    snapshot.resolve({ available: true, currentSessionId: "s1" });
    await syncing;
    vi.runAllTimers();
    expect(source.closed).toBe(true);
    expect(runtime.eventSource).toBeNull();
    expect(runtime.resetTimer).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
