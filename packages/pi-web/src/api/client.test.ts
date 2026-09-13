import { describe, expect, it, vi } from "vitest";
import { ApiConnectionError, ApiError, createApiClient } from "./client";

describe("api client", () => {
  it("unwraps data envelopes and sends JSON with same-origin credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client<{ ok: boolean }>("/api/example", { method: "POST", body: { value: 1 } })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/example", expect.objectContaining({ body: "{\"value\":1}", credentials: "same-origin" }));
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("preserves observatory envelope metadata when data is an object", async () => {
    const meta = { dbAvailable: false, warnings: ["memory database does not exist"] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { items: [] }, meta }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client<{ items: unknown[]; meta: typeof meta }>("/api/memory/observatory/jobs")).resolves.toEqual({ items: [], meta });
  });

  it("throws a typed API error with stable status and code", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "Session changed", code: "SESSION_CHANGED" }), { status: 409, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ fetch: fetchMock });

    const error = await client("/api/chat/messages").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Session changed", status: 409, code: "SESSION_CHANGED" });
  });

  it("distinguishes connection failures and aborts", async () => {
    const onConnectionChange = vi.fn();
    const offline = createApiClient({ fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")), onConnectionChange });
    await expect(offline("/api/overview")).rejects.toBeInstanceOf(ApiConnectionError);
    expect(onConnectionChange).toHaveBeenCalledWith(false);

    const aborted = createApiClient({ fetch: vi.fn<typeof fetch>().mockRejectedValue(new DOMException("stopped", "AbortError")) });
    await expect(aborted("/api/overview")).rejects.toMatchObject({ name: "AbortError" });
  });
});
