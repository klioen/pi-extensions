export type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };
export type ApiRequest = <T>(path: string, options?: RequestOptions) => Promise<T>;

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export const requestJson: ApiRequest = async <T>(path: string, options: RequestOptions = {}) => {
  const headers = new Headers(options.headers);
  const { body, ...requestOptions } = options;
  const init: RequestInit = { ...requestOptions, headers, credentials: "same-origin" };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("json")
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
    throw new ApiError(response.status, String(record?.error ?? record?.message ?? payload ?? `HTTP ${response.status}`), payload);
  }
  return payload as T;
};
