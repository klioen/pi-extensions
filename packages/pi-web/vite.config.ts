import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendPort = Number(process.env.PI_WEB_PORT || 8787);

type ProxyRequest = { setHeader(name: string, value: string): void };
type ProxyServer = { on(event: "proxyReq", listener: (request: ProxyRequest) => void): void };

export function rewriteProxyRequestOrigin(request: ProxyRequest, target: string) {
  request.setHeader("Origin", new URL(target).origin);
}

export function createApiProxy(port: number) {
  const resolvedPort = Number.isInteger(port) ? port : 8787;
  const target = `http://127.0.0.1:${resolvedPort}`;
  return {
    target,
    changeOrigin: true,
    configure(proxy: ProxyServer) {
      proxy.on("proxyReq", (request) => rewriteProxyRequestOrigin(request, target));
    },
  } as const;
}

export default defineConfig(({ mode }) => ({
  base: "./",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: mode === "smoke" ? ".vite-smoke" : "public",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": createApiProxy(backendPort),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
  },
}));
