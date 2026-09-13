import { TextDecoder, TextEncoder } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createApiProxy: typeof import("../../vite.config").createApiProxy;
let rewriteProxyRequestOrigin: typeof import("../../vite.config").rewriteProxyRequestOrigin;

beforeAll(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("TextEncoder", TextEncoder);
  vi.stubGlobal("TextDecoder", TextDecoder);
  ({ createApiProxy, rewriteProxyRequestOrigin } = await import("../../vite.config"));
});

describe("Vite development proxy", () => {
  it("rewrites the Origin header to the target origin on proxyReq", () => {
    const setHeader = vi.fn();

    rewriteProxyRequestOrigin({ setHeader }, "http://127.0.0.1:9123/api");

    expect(setHeader).toHaveBeenCalledOnce();
    expect(setHeader).toHaveBeenCalledWith("Origin", "http://127.0.0.1:9123");
  });

  it("registers Origin rewriting in the API proxy configure hook", () => {
    const proxy = createApiProxy(9123);
    const on = vi.fn();
    proxy.configure({ on } as never);

    expect(proxy.target).toBe("http://127.0.0.1:9123");
    expect(proxy.changeOrigin).toBe(true);
    expect(on).toHaveBeenCalledWith("proxyReq", expect.any(Function));

    const listener = on.mock.calls[0]?.[1] as (request: { setHeader(name: string, value: string): void }) => void;
    const setHeader = vi.fn();
    listener({ setHeader });
    expect(setHeader).toHaveBeenCalledWith("Origin", "http://127.0.0.1:9123");
  });
});
