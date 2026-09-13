export type ChatPhase = "loading" | "ready" | "unavailable" | "error";
export type ChatRunState = "queued" | "running" | "aborting" | "done" | "killed" | "failed";
export type ChatMessageStatus = "sending" | "accepted" | "queued" | "running" | "streaming" | "done" | "killed" | "failed" | "error";

export interface ChatContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface ChatHistoryEntry {
  id?: string;
  role?: string;
  content?: string | ChatContentPart[];
  timestamp?: string | number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: string;
  text?: string;
  timestamp?: string | number;
  status: ChatMessageStatus;
  history?: boolean;
  runId?: string;
  requestId?: string;
  parentMessageId?: string;
  blockIndex?: number;
  error?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: unknown;
  result?: unknown;
}

export interface PendingRequest {
  requestId: string;
  text: string;
  status: ChatMessageStatus;
  createdAt: number;
}

export interface ActiveRun {
  runId: string;
  requestId?: string;
  state: ChatRunState;
}

export interface ChatSnapshot {
  available: boolean;
  currentSessionId?: string;
  sessionName?: string;
  cwd?: string;
  idle?: boolean;
  hasPendingMessages?: boolean;
  activeRun?: ActiveRun | null;
  eventCursor?: number;
  capabilities?: {
    send?: boolean;
    followUp?: boolean;
    abort?: boolean;
  };
}

export interface ChatHistory {
  sessionId: string;
  revision?: string;
  truncated?: boolean;
  entries?: ChatHistoryEntry[];
}

export interface ChatEventEnvelope {
  id: number;
  type: string;
  timestamp?: number;
  sessionId: string;
  runId?: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

export interface ChatAcceptance {
  accepted?: boolean;
  requestId?: string;
  delivery: "immediate" | "followUp";
}

export interface ChatState {
  phase: ChatPhase;
  connected: boolean;
  available: boolean;
  snapshot: ChatSnapshot | null;
  sessionId: string;
  messages: ChatMessage[];
  activeRun: ActiveRun | null;
  pendingRequests: Map<string, PendingRequest>;
  error: string;
}
