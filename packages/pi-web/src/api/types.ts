export interface ObservatoryMeta extends Record<string, unknown> {
  dbAvailable?: boolean;
  capabilities?: Record<string, boolean>;
  warnings?: string[];
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: ObservatoryMeta;
}

export interface ApiErrorPayload {
  error?: string;
  message?: string;
  code?: string;
  details?: unknown;
}

export interface SessionSummary {
  id: string;
  name?: string;
  title?: string;
  firstMessage?: string;
  cwd?: string;
  projectId?: string;
  messageCount?: number;
  modified?: string | number;
  updatedAt?: string | number;
  current?: boolean;
  status?: string;
}

export interface Project {
  key: string;
  cwd: string;
  label: string;
  modified?: string | number;
}

export interface SessionsResponse {
  items?: SessionSummary[];
  sessions?: SessionSummary[];
  results?: SessionSummary[];
}

export type ApiConnectionListener = (connected: boolean) => void;
