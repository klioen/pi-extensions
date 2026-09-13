import { describe, expect, it } from "vitest";
import { historyMessages, reduceChatEvent } from "./reducer";
import type { ChatState } from "./types";

function state(): ChatState {
  return { phase: "ready", connected: true, available: true, snapshot: null, sessionId: "s1", messages: [], activeRun: null, pendingRequests: new Map(), error: "" };
}

describe("chat reducer", () => {
  it("merges history tool calls and results by toolCallId", () => {
    const messages = historyMessages([
      { id: "a1", role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }] },
      { id: "r1", role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "done" }] },
    ]);
    expect(messages.filter((message) => message.role === "tool")).toEqual([expect.objectContaining({ toolCallId: "call-1", result: "done" })]);
  });

  it("preserves historical reasoning as a separate message before the assistant answer", () => {
    const messages = historyMessages([{ id: "a1", role: "assistant", content: [
      { type: "thinking", text: "Check the constraints" },
      { type: "text", text: "Final answer" },
    ] }]);
    expect(messages).toEqual([
      expect.objectContaining({ id: "a1-thinking-0", role: "reasoning", text: "Check the constraints", status: "done" }),
      expect.objectContaining({ id: "a1", role: "assistant", text: "Final answer", status: "done" }),
    ]);
  });

  it("preserves interleaved historical reasoning, text, and tools", () => {
    const messages = historyMessages([{ id: "a1", role: "assistant", content: [
      { type: "thinking", text: "First thought" },
      { type: "text", text: "First answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      { type: "thinking", text: "Second thought" },
      { type: "text", text: "Second answer" },
    ] }]);
    expect(messages.map((message) => [message.role, message.text, message.toolName])).toEqual([
      ["reasoning", "First thought", undefined],
      ["assistant", "First answer", undefined],
      ["tool", undefined, "read"],
      ["reasoning", "Second thought", undefined],
      ["assistant", "Second answer", undefined],
    ]);
  });

  it("streams reasoning independently before the assistant answer", () => {
    const withAssistant = reduceChatEvent(state(), { id: 1, type: "message.started", sessionId: "s1", runId: "run-1", data: { messageId: "a1", role: "assistant", text: "" } });
    const started = reduceChatEvent(withAssistant, { id: 2, type: "reasoning.started", sessionId: "s1", runId: "run-1", data: { messageId: "reasoning-a1-0", parentMessageId: "a1", blockIndex: 0, role: "reasoning", text: "" } });
    const completed = reduceChatEvent(started, { id: 3, type: "reasoning.completed", sessionId: "s1", runId: "run-1", data: { messageId: "reasoning-a1-0", parentMessageId: "a1", blockIndex: 0, role: "reasoning", text: "Checking constraints", status: "done" } });
    expect(completed.messages.map((message) => message.id)).toEqual(["reasoning-a1-0", "a1"]);
    expect(completed.messages[0]).toEqual(expect.objectContaining({ role: "reasoning", text: "Checking constraints", status: "done" }));
  });

  it("orders late tool events by assistant content block index", () => {
    let next = reduceChatEvent(state(), { id: 1, type: "message.started", sessionId: "s1", data: { messageId: "a1-text-0", parentMessageId: "a1", blockIndex: 0, role: "assistant", text: "first" } });
    next = reduceChatEvent(next, { id: 2, type: "message.started", sessionId: "s1", data: { messageId: "a1-text-2", parentMessageId: "a1", blockIndex: 2, role: "assistant", text: "second" } });
    next = reduceChatEvent(next, { id: 3, type: "tool.started", sessionId: "s1", data: { toolCallId: "call-1", parentMessageId: "a1", blockIndex: 1, toolName: "read", status: "running" } });
    expect(next.messages.map((message) => [message.role, message.blockIndex])).toEqual([["assistant", 0], ["tool", 1], ["assistant", 2]]);
  });

  it("removes a reasoning block when the authoritative completion is empty", () => {
    const started = reduceChatEvent(state(), { id: 1, type: "reasoning.started", sessionId: "s1", data: { messageId: "reasoning-redacted", role: "reasoning", text: "" } });
    const visible = reduceChatEvent(started, { id: 2, type: "reasoning.completed", sessionId: "s1", data: { messageId: "reasoning-redacted", role: "reasoning", text: "temporarily visible", status: "done" } });
    const retracted = reduceChatEvent(visible, { id: 3, type: "reasoning.completed", sessionId: "s1", data: { messageId: "reasoning-redacted", role: "reasoning", text: "", status: "done" } });
    expect(retracted.messages).toHaveLength(0);
  });

  it("uses the safe message from a structured tool error", () => {
    const value = reduceChatEvent(state(), {
      id: 2,
      type: "tool.completed",
      sessionId: "s1",
      data: { toolCallId: "call-1", toolName: "read", status: "error", error: { code: "ENOENT", message: "File not found" } },
    });
    expect(value.messages).toEqual([
      expect.objectContaining({ id: "tool-call-1", status: "error", error: "File not found" }),
    ]);
  });

  it("stores structured assistant errors from the real completed-event shape", () => {
    const next = reduceChatEvent(state(), {
      id: 2,
      type: "message.completed",
      sessionId: "s1",
      data: { messageId: "assistant-1", role: "assistant", text: "The assistant run failed", status: "error", error: { code: "RUN_FAILED", message: "The assistant run failed" } },
    });
    expect(next.messages[0]).toEqual(expect.objectContaining({ status: "error", error: "The assistant run failed" }));
  });

  it("reconciles a pre-ack user event without duplicating optimistic state", () => {
    const initial = state();
    initial.messages.push({ id: "request-r1", role: "user", text: "hello", status: "sending", requestId: "r1" });
    initial.pendingRequests.set("r1", { requestId: "r1", text: "hello", status: "sending", createdAt: 1 });
    const event = { id: 1, type: "message.started", sessionId: "s1", requestId: "r1", data: { messageId: "user-1", role: "user", text: "hello" } };
    const once = reduceChatEvent(initial, event);
    const value = reduceChatEvent(once, event);
    expect(initial.messages[0].id).toBe("request-r1");
    expect(value.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(value.messages[0].id).toBe("user-1");
  });

  it("preserves only an unrelated POST still awaiting acceptance when an operation settles", () => {
    const initial = state();
    initial.activeRun = { runId: "run-1", requestId: "r2", state: "running" };
    for (const requestId of ["r2", "r3"]) {
      initial.pendingRequests.set(requestId, { requestId, text: requestId, status: "sending", createdAt: 1 });
      initial.messages.push({ id: `request-${requestId}`, role: "user", text: requestId, status: "sending", requestId });
    }

    const value = reduceChatEvent(initial, {
      id: 3,
      type: "run.settled",
      sessionId: "s1",
      runId: "run-1",
      requestId: "r2",
      data: { state: "done" },
    });

    expect([...value.pendingRequests.keys()]).toEqual(["r3"]);
    expect(value.messages.map((message) => [message.requestId, message.status])).toEqual([
      ["r2", "done"],
      ["r3", "sending"],
    ]);
  });

  it.each(["running", "queued"] as const)("clears every accepted request in a settled operation when the last span is %s", (lastStatus) => {
    const initial = state();
    initial.activeRun = { runId: "run-1", requestId: "r2", state: "running" };
    for (const [requestId, status] of [["r1", "running"], ["r2", lastStatus]] as const) {
      initial.pendingRequests.set(requestId, { requestId, text: requestId, status, createdAt: 1 });
      initial.messages.push({ id: `request-${requestId}`, role: "user", text: requestId, status, requestId });
    }

    const value = reduceChatEvent(initial, {
      id: 3,
      type: "run.settled",
      sessionId: "s1",
      runId: "run-1",
      requestId: "r2",
      data: { state: "done" },
    });

    expect(value.activeRun).toBeNull();
    expect(value.pendingRequests.size).toBe(0);
    expect(value.messages.map((message) => [message.requestId, message.status])).toEqual([
      ["r1", "done"],
      ["r2", "done"],
    ]);
  });
});
