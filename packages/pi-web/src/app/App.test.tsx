import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn(async () => ({})) }));
vi.mock("../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client")>();
  return { ...original, api: apiMock, apiClient: apiMock };
});

import { projectKey } from "../api/resources";
import App from "./App";

const jsonResponse = (value: unknown = {}) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  window.location.hash = "#/overview";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/api/chat/snapshot")) return jsonResponse({ available: false, currentSessionId: "" });
    return jsonResponse();
  }));
  vi.stubGlobal("EventSource", class {
    close() {}
    addEventListener() {}
  });
});

async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("App", () => {
  it("mounts the React control deck and injected route", async () => {
    render(<App routes={{ overview: () => <h2>Injected overview</h2> }} />);
    expect(await screen.findByRole("heading", { name: "Injected overview" })).toBeInTheDocument();
  });

  it("keeps the selected project in the URL when opening a session", async () => {
    const alphaProject = projectKey({ cwd: "/work/alpha" });
    window.location.hash = `#/sessions?project=${alphaProject}`;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sessions") return jsonResponse({ sessions: [
        { id: "alpha-1", name: "Alpha session", cwd: "/work/alpha" },
        { id: "beta-1", name: "Beta session", cwd: "/work/beta" },
      ] });
      if (path === "/api/sessions/alpha-1") return jsonResponse({ session: { id: "alpha-1", name: "Alpha session", cwd: "/work/alpha" }, chatHistory: [] });
      return jsonResponse();
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /Alpha session/ })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Sessions" })).toHaveLength(1);
    expect(screen.queryByText("Sessions in /work/alpha")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta session/ })).not.toBeInTheDocument();
    await act(async () => { screen.getByRole("button", { name: /Alpha session/ }).click(); });
    expect(window.location.hash).toBe(`#/sessions/alpha-1?project=${alphaProject}`);
    expect(await screen.findByRole("heading", { name: "Alpha session" })).toBeInTheDocument();
  });

  it.each(["#/sessions/alpha-1", "#/sessions/alpha-1?project=wrong-project"])("canonicalizes a session deep link to its actual project: %s", async (hash) => {
    const alphaProject = "project-alpha";
    window.location.hash = hash;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sessions") return jsonResponse({ sessions: [{ id: "alpha-1", name: "Alpha session", cwd: "/work/alpha", projectId: alphaProject }] });
      if (path === "/api/sessions/alpha-1") return jsonResponse({ session: { id: "alpha-1", name: "Alpha session", cwd: "/work/alpha", projectId: alphaProject }, chatHistory: [] });
      return jsonResponse();
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /Alpha session/ })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe(`#/sessions/alpha-1?project=${alphaProject}`));
  });

  it("navigates to every registered default route without real network access", async () => {
    render(<App />);

    expect(await screen.findByText("A readout of this Pi installation and its local assets.")).toBeInTheDocument();

    await navigate("#/chat");
    expect(await screen.findByRole("region", { name: "Current session chat" })).toBeInTheDocument();

    await navigate("#/sessions");
    expect(await screen.findByText("No session projects found.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Sessions" })).toHaveLength(1);

    await navigate("#/skills");
    expect(await screen.findByText("Inspect effective skills and edit only resources authorized by the server.")).toBeInTheDocument();

    await navigate("#/extensions");
    expect(await screen.findByText("Static inventory only. Pi Web does not load extension code or mutate packages.")).toBeInTheDocument();

    await navigate("#/disk/project/src");
    expect(await screen.findByRole("navigation", { name: "Disk path" })).toBeInTheDocument();

    await navigate("#/memory/overview");
    expect(await screen.findByRole("heading", { name: "Memory Overview" })).toBeInTheDocument();
  });
});
