import type { ApiConnectionListener, ApiEnvelope, ApiErrorPayload } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: unknown;

  constructor(message: string, options: { status: number; code?: string; payload?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.payload = options.payload;
  }
}

export class ApiConnectionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("无法连接 Pi Web 服务。");
    this.name = "ApiConnectionError";
    this.cause = cause;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  onConnectionChange?: ApiConnectionListener;
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "data"));
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (payload && typeof payload === "object") {
    const candidate = payload as ApiErrorPayload;
    if (candidate.error) return candidate.error;
    if (candidate.message) return candidate.message;
  }
  return `HTTP ${status}`;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  return async function request<T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> {
    const headers = new Headers(requestOptions.headers);
    let body = requestOptions.body;
    if (body != null && !(body instanceof FormData) && !(body instanceof URLSearchParams) && typeof body !== "string" && !(body instanceof Blob)) {
      body = JSON.stringify(body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await requestFetch(path, {
        ...requestOptions,
        body: body as BodyInit | null | undefined,
        credentials: "same-origin",
        headers,
      });
      options.onConnectionChange?.(true);
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
      options.onConnectionChange?.(false);
      throw new ApiConnectionError(error);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("json")
      ? await response.json().catch(() => ({}))
      : await response.text();

    if (!response.ok) {
      const detail = payload && typeof payload === "object" ? payload as ApiErrorPayload : undefined;
      throw new ApiError(errorMessage(payload, response.status), {
        status: response.status,
        code: detail?.code,
        payload,
      });
    }

    if (isEnvelope<T>(payload)) {
      if (payload.meta && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
        return { ...payload.data, meta: payload.meta } as T;
      }
      return payload.data;
    }
    return payload as T;
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export const apiClient = createApiClient();
// Stable shorthand used by route modules; keep the client itself injectable in tests.
export const api = apiClient;
