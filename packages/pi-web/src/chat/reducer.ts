import type { ChatEventEnvelope, ChatHistoryEntry, ChatMessage, ChatState, PendingRequest } from "./types";

export function contentText(content: ChatHistoryEntry["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function historyMessages(entries: ChatHistoryEntry[] = []): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, ChatMessage>();
  const upsertTool = (toolCallId: string | undefined, values: Partial<ChatMessage>) => {
    const key = toolCallId || values.id || `history-tool-${messages.length}`;
    let tool = tools.get(key);
    if (!tool) {
      tool = { id: `tool-${key}`, role: "tool", toolCallId, status: "done", history: true };
      tools.set(key, tool);
      messages.push(tool);
    }
    Object.assign(tool, values);
    return tool;
  };

  entries.forEach((entry, index) => {
    const requestId = typeof (entry as ChatHistoryEntry & { requestId?: unknown }).requestId === "string"
      ? (entry as ChatHistoryEntry & { requestId: string }).requestId
      : undefined;
    if (entry.role === "toolResult") {
      upsertTool(entry.toolCallId, {
        toolName: entry.toolName || "Tool result",
        status: entry.isError ? "error" : "done",
        result: contentText(entry.content),
      });
      return;
    }
    const entryId = entry.id || `history-${index}`;
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      let text = "";
      let textGroup = 0;
      let textBlockIndex: number | undefined;
      const flushText = () => {
        if (!text || textBlockIndex === undefined) return;
        messages.push({
          id: textGroup === 0 ? entryId : `${entryId}-text-${textGroup}`,
          role: "assistant",
          text,
          timestamp: entry.timestamp,
          status: "done",
          requestId: textGroup === 0 ? requestId : undefined,
          history: true,
          parentMessageId: entryId,
          blockIndex: textBlockIndex,
        });
        text = "";
        textBlockIndex = undefined;
        textGroup += 1;
      };
      entry.content.forEach((block, blockIndex) => {
        if (block?.type === "text" && typeof block.text === "string") {
          if (textBlockIndex === undefined) textBlockIndex = blockIndex;
          text += block.text;
          return;
        }
        flushText();
        if (block?.type === "thinking" && typeof block.text === "string" && block.text) {
          messages.push({ id: `${entryId}-thinking-${blockIndex}`, role: "reasoning", text: block.text, timestamp: entry.timestamp, status: "done", history: true, parentMessageId: entryId, blockIndex });
        } else if (block?.type === "toolCall") {
          upsertTool(block.id, { toolName: block.name || "Tool", arguments: block.arguments, parentMessageId: entryId, blockIndex });
        }
      });
      flushText();
    } else {
      messages.push({
        id: entryId,
        role: entry.role || "custom",
        text: contentText(entry.content),
        timestamp: entry.timestamp,
        status: "done",
        requestId,
        history: true,
      });
    }
  });
  return messages;
}

export function mergePendingMessages(messages: ChatMessage[], pendingRequests: Map<string, PendingRequest>): ChatMessage[] {
  const merged = messages.map((message) => ({ ...message }));
  const authoritativeRequestIds = new Set(merged.flatMap((message) => message.requestId ? [message.requestId] : []));
  for (const pending of pendingRequests.values()) {
    if (!(["sending", "queued", "running"] as ChatMessage["status"][]).includes(pending.status)) continue;
    if (authoritativeRequestIds.has(pending.requestId)) continue;
    merged.push({
      id: `request-${pending.requestId}`,
      role: "user",
      text: pending.text,
      status: pending.status,
      requestId: pending.requestId,
    });
  }
  return merged;
}

function updateRequestStatus(state: ChatState, requestId: string | undefined, status: ChatMessage["status"]): void {
  if (!requestId) return;
  const pending = state.pendingRequests.get(requestId);
  if (pending) pending.status = status;
  const message = state.messages.find((item) => item.requestId === requestId);
  if (message && message.status !== "done") message.status = status;
}

function settlePendingRequests(state: ChatState, status: ChatMessage["status"], terminalRequestId?: string): void {
  // run.settled closes the whole operation; its requestId identifies only the final request span.
  for (const [requestId, pending] of state.pendingRequests) {
    if (pending.status === "sending" && requestId !== terminalRequestId) continue;
    updateRequestStatus(state, requestId, status);
    state.pendingRequests.delete(requestId);
  }
}

function applyMessage(state: ChatState, event: ChatEventEnvelope): void {
  const data = event.data || {};
  const messageId = typeof data.messageId === "string" ? data.messageId : `event-${event.id}`;
  let message = state.messages.find((item) => item.id === messageId);
  if (!message && data.role === "user" && event.requestId) {
    message = state.messages.find((item) => item.requestId === event.requestId);
    if (message) message.id = messageId;
  }
  if (!message) {
    message = {
      id: messageId,
      role: typeof data.role === "string" ? data.role : "assistant",
      text: "",
      status: "streaming",
      runId: event.runId,
      requestId: event.requestId,
    };
    message.parentMessageId = typeof data.parentMessageId === "string" ? data.parentMessageId : undefined;
    message.blockIndex = typeof data.blockIndex === "number" ? data.blockIndex : undefined;
    if (message.parentMessageId && message.blockIndex !== undefined) {
      const siblings = state.messages.map((item, index) => ({ item, index })).filter(({ item }) => item.parentMessageId === message!.parentMessageId);
      const next = siblings.find(({ item }) => (item.blockIndex ?? Number.MAX_SAFE_INTEGER) > message!.blockIndex!);
      const parentIndex = state.messages.findIndex((item) => item.id === message!.parentMessageId);
      const emptyParentAnchor = parentIndex >= 0 && !state.messages[parentIndex].text ? parentIndex : -1;
      const insertAt = next?.index ?? (siblings.length ? siblings.at(-1)!.index + 1 : emptyParentAnchor >= 0 ? emptyParentAnchor : state.messages.length);
      state.messages.splice(insertAt, 0, message);
    } else if (message.role === "reasoning" && message.parentMessageId) {
      const parentIndex = state.messages.findIndex((item) => item.id === message!.parentMessageId);
      if (parentIndex >= 0 && !state.messages[parentIndex].text) state.messages.splice(parentIndex, 0, message);
      else state.messages.push(message);
    } else state.messages.push(message);
  }
  if (event.requestId && !message.requestId) message.requestId = event.requestId;
  if (event.type === "message.delta" || event.type === "reasoning.delta") message.text = `${message.text || ""}${typeof data.delta === "string" ? data.delta : ""}`;
  else if (typeof data.text === "string") message.text = data.text;
  if (event.type === "message.completed" || event.type === "reasoning.completed") {
    message.status = typeof data.status === "string" ? data.status as ChatMessage["status"] : "done";
    const removableEmptyBlock = !message.text && !data.error && (
      event.type === "reasoning.completed" || (event.type === "message.completed" && Boolean(message.parentMessageId) && message.blockIndex !== undefined)
    );
    if (removableEmptyBlock) {
      state.messages.splice(state.messages.indexOf(message), 1);
      return;
    }
    if (typeof data.error === "string") message.error = data.error;
    else if (data.error && typeof data.error === "object") {
      const errorMessage = (data.error as Record<string, unknown>).message;
      if (typeof errorMessage === "string") message.error = errorMessage;
    }
  }
}

function applyTool(state: ChatState, event: ChatEventEnvelope): void {
  const data = event.data || {};
  const callId = typeof data.toolCallId === "string" ? data.toolCallId : String(event.id);
  const id = `tool-${callId}`;
  let tool = state.messages.find((item) => item.id === id);
  if (!tool) {
    tool = {
      id,
      role: "tool",
      toolCallId: callId,
      runId: event.runId,
      status: "running",
      parentMessageId: typeof data.parentMessageId === "string" ? data.parentMessageId : undefined,
      blockIndex: typeof data.blockIndex === "number" ? data.blockIndex : undefined,
    };
    if (tool.parentMessageId && tool.blockIndex !== undefined) {
      const siblings = state.messages.map((item, index) => ({ item, index })).filter(({ item }) => item.parentMessageId === tool!.parentMessageId);
      const next = siblings.find(({ item }) => (item.blockIndex ?? Number.MAX_SAFE_INTEGER) > tool!.blockIndex!);
      state.messages.splice(next?.index ?? (siblings.length ? siblings.at(-1)!.index + 1 : state.messages.length), 0, tool);
    } else state.messages.push(tool);
  }
  tool.toolName = typeof data.toolName === "string" ? data.toolName : tool.toolName || "Tool";
  if (typeof data.parentMessageId === "string") tool.parentMessageId = data.parentMessageId;
  if (typeof data.blockIndex === "number") tool.blockIndex = data.blockIndex;
  tool.status = typeof data.status === "string" ? data.status as ChatMessage["status"] : tool.status;
  if (Object.prototype.hasOwnProperty.call(data, "arguments")) tool.arguments = data.arguments;
  if (Object.prototype.hasOwnProperty.call(data, "result")) tool.result = data.result;
  if (typeof data.error === "string") tool.error = data.error;
  else if (data.error && typeof data.error === "object") {
    const message = (data.error as Record<string, unknown>).message;
    if (typeof message === "string") tool.error = message;
  }
}

/** Pure event reducer. Runtime-owned Maps and message objects are cloned before updates. */
export function reduceChatEvent(current: ChatState, event: ChatEventEnvelope): ChatState {
  const state: ChatState = {
    ...current,
    snapshot: current.snapshot ? { ...current.snapshot } : null,
    activeRun: current.activeRun ? { ...current.activeRun } : null,
    messages: current.messages.map((message) => ({ ...message })),
    pendingRequests: new Map([...current.pendingRequests].map(([id, request]) => [id, { ...request }])),
  };
  const data = event.data || {};
  switch (event.type) {
    case "snapshot":
      state.snapshot = { ...(state.snapshot || { available: state.available }), ...data } as ChatState["snapshot"];
      if (data.activeRun !== undefined) state.activeRun = data.activeRun as ChatState["activeRun"];
      break;
    case "request.accepted":
      updateRequestStatus(state, event.requestId, (typeof data.state === "string" ? data.state : data.delivery === "followUp" ? "queued" : "accepted") as ChatMessage["status"]);
      break;
    case "run.started":
      if (event.runId) state.activeRun = { runId: event.runId, requestId: event.requestId, state: "running" };
      updateRequestStatus(state, event.requestId, "running");
      break;
    case "message.started":
    case "message.delta":
    case "message.completed":
    case "reasoning.started":
    case "reasoning.delta":
    case "reasoning.completed":
      applyMessage(state, event);
      break;
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      applyTool(state, event);
      break;
    case "run.abort_requested": {
      const activeRun = state.activeRun;
      if (activeRun && activeRun.runId === event.runId) state.activeRun = { ...activeRun, state: "aborting" };
      break;
    }
    case "run.settled":
      if (!state.activeRun || state.activeRun.runId === event.runId) {
        state.activeRun = null;
        settlePendingRequests(state, (typeof data.state === "string" ? data.state : "done") as ChatMessage["status"], event.requestId);
      }
      break;
    case "runtime.error":
      state.error = typeof data.message === "string" ? data.message : "Chat runtime error";
      break;
  }
  return state;
}
