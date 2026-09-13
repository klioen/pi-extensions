import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MemoryPage from "./MemoryPage";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: vi.fn() }));
const mockedApi = vi.mocked(api);

function Navigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate("/memory/jobs")}>Go to jobs</button>;
}

function renderPage(path: string, withNavigation = false) {
  return render(<MemoryRouter initialEntries={[path]}>{withNavigation && <Navigation />}<Routes><Route path="/memory/*" element={<MemoryPage />} /></Routes></MemoryRouter>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("MemoryPage", () => {
  beforeEach(() => mockedApi.mockReset());
  afterEach(cleanup);

  it("routes indexed sessions to the sessions endpoint", async () => {
    mockedApi.mockResolvedValue({ items: [{ sessionId: "session-1", scanStatus: "complete", phase1Status: "available", updatedAt: 1 }] });
    renderPage("/memory/sessions");
    expect(await screen.findByRole("heading", { name: "Indexed Sessions" })).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledWith("/api/memory/observatory/sessions");
    expect(screen.getAllByText("session-1")).toHaveLength(2);
  });

  it("shows observatory envelope unavailability and warnings in the notice", async () => {
    mockedApi.mockResolvedValue({ items: [], meta: { dbAvailable: false, warnings: ["memory database does not exist"] } });
    renderPage("/memory/jobs");
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Database unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("memory database does not exist")).toBeInTheDocument();
  });

  it("ignores a stale response after a rapid route change", async () => {
    const sessions = deferred<Record<string, unknown>>();
    mockedApi.mockImplementation(async (path: string) => {
      if (String(path).endsWith("/sessions")) return sessions.promise;
      if (String(path).endsWith("/jobs")) return { items: [{ id: "new-job", status: "complete" }] };
      return {};
    });
    renderPage("/memory/sessions", true);
    await userEvent.click(screen.getByRole("button", { name: "Go to jobs" }));
    expect(await screen.findAllByText("new-job")).toHaveLength(2);
    await act(async () => { sessions.resolve({ items: [{ sessionId: "stale-session" }] }); await sessions.promise; });
    expect(screen.queryByText("stale-session")).not.toBeInTheDocument();
    expect(screen.getAllByText("new-job")).toHaveLength(2);
  });

  it("requires confirmation before requesting sensitive rollout content", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (String(path).endsWith("/phase1/session-1")) return { sessionId: "session-1", rawMemoryBytes: 9, rolloutSummaryBytes: 5 };
      return { content: "private content", truncated: false };
    });
    renderPage("/memory/rollouts/session-1");
    await screen.findByRole("heading", { name: "Rollout detail" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Load raw memory" }));
    expect(screen.getByRole("dialog", { name: "Load raw memory?" })).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Confirm and load" }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/api/memory/observatory/phase1/session-1/content?field=rawMemory"));
    expect(await screen.findByText("private content")).toBeInTheDocument();
  });

  it("loads artifact metadata without requesting file content until confirmation", async () => {
    mockedApi.mockImplementation(async (path: string) => String(path).endsWith("/content")
      ? { content: "secret artifact", truncated: false }
      : { artifact: { id: "raw", name: "raw_memories.md", kind: "file", size: 15 } });
    renderPage("/memory/artifact/raw");
    expect(await screen.findByRole("heading", { name: "File content" })).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("secret artifact")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load file content" }));
    expect(screen.getByRole("dialog", { name: "Load raw_memories.md?" })).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Confirm and load" }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/api/memory/observatory/artifacts/raw/content"));
    expect(await screen.findByText("secret artifact")).toBeInTheDocument();
  });

  it("reads artifact directory metadata directly without a content request", async () => {
    mockedApi.mockResolvedValue({ artifact: { id: "skills", name: "skills", kind: "directory", entries: [{ id: "skill-a", name: "skill-a" }] } });
    renderPage("/memory/artifact/skills");
    expect(await screen.findByRole("link", { name: "skill-a" })).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi).not.toHaveBeenCalledWith(expect.stringContaining("/content"));
  });
});
