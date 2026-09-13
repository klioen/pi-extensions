import type { ChatAcceptance, ChatEventEnvelope, ChatEventHub } from "../lib/chat-core.cjs";

export interface PiWebAddress { host: string; port: number; url: string }
export interface PiWebChatSnapshot {
  available: boolean;
  currentSessionId?: string;
  sessionName?: string;
  cwd?: string;
  idle: boolean;
  hasPendingMessages: boolean;
  activeRun: null | { runId: string; state?: string; [key: string]: unknown };
  eventCursor?: number;
  capabilities: Record<string, boolean>;
}
export interface PiWebCurrentSessionRecord { id: string; path: string }
export interface PiWebChatAdapter {
  getSnapshot(): PiWebChatSnapshot;
  getCurrentSessionRecord(): Promise<PiWebCurrentSessionRecord | undefined> | PiWebCurrentSessionRecord | undefined;
  sendUserMessage(input: { requestId: string; text: string }): Promise<ChatAcceptance> | ChatAcceptance;
  abort(input: { sessionId: string; runId: string }): Promise<void> | void;
  subscribe?(listener: (event: Omit<ChatEventEnvelope, "id" | "timestamp"> & { timestamp?: number }) => void): () => void;
}
export interface PiWebServerOptions {
  host?: string;
  port?: number;
  cwd?: string;
  agentDir?: string;
  memoryDir?: string;
  memoryDbPath?: string;
  piRootDir?: string;
  diskUsageTtlMs?: number;
  diskUsageConcurrency?: number;
  diskUsageMaxEntries?: number;
  diskUsageMaxDepth?: number;
  publicDir?: string;
  projectTrusted?: boolean;
  chatAdapter?: PiWebChatAdapter;
  eventHub?: ChatEventHub;
  sseHeartbeatMs?: number;
  maxSseClients?: number;
  listSessions?: () => Promise<any[]>;
  listEffectiveSkills?: () => any[];
  getCurrentSessionId?: () => string | undefined;
  renameSession?: (session: any, name: string, current: boolean) => void;
  deleteSession?: (session: any) => { method?: string } | void;
}
export interface PiWebServer {
  host: string;
  requestedPort: number;
  catalog: any;
  start(): Promise<PiWebAddress | undefined>;
  stop(): Promise<void>;
  address(): PiWebAddress | undefined;
}
export function createPiWebServer(options?: PiWebServerOptions): PiWebServer;
export function createCatalog(options?: PiWebServerOptions): any;
