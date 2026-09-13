import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiskUsagePage from "./DiskUsagePage";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: vi.fn() }));
const mockedApi = vi.mocked(api);

const result = {
  current: { relativePath: "projects/demo" },
  breadcrumbs: [{ name: "/", relativePath: "" }, { name: "projects", relativePath: "projects" }, { name: "demo", relativePath: "projects/demo" }],
  parent: "projects", totalSize: 100, fileCount: 1, directoryCount: 1, scannedAt: "2026-09-11T10:00:00Z", durationMs: 12,
  items: [{ name: "src", relativePath: "projects/demo/src", type: "directory", size: 75, percent: 75, canDrillDown: true }, { name: "a.txt", relativePath: "projects/demo/a.txt", type: "file", size: 25, percent: 25 }], diagnostics: [], partial: false,
};

function Navigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate("/disk/projects/next")}>Go to next path</button>;
}

function renderPage(withNavigation = false) {
  return render(<MemoryRouter initialEntries={["/disk/projects/demo"]}>{withNavigation && <Navigation />}<Routes><Route path="/disk/*" element={<DiskUsagePage />} /></Routes></MemoryRouter>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("DiskUsagePage", () => {
  beforeEach(() => mockedApi.mockReset().mockResolvedValue(result));
  afterEach(cleanup);
  it("uses the route path and changes sort direction", async () => {
    renderPage();
    await screen.findByRole("cell", { name: /a\.txt/ });
    expect(mockedApi).toHaveBeenLastCalledWith(expect.stringContaining("path=projects%2Fdemo"));
    await userEvent.click(screen.getByRole("button", { name: /Sort by name/i }));
    await waitFor(() => expect(mockedApi).toHaveBeenLastCalledWith(expect.stringMatching(/sort=name.*order=asc/)));
    await userEvent.click(screen.getByRole("button", { name: /Sort by name, ascending/i }));
    await waitFor(() => expect(mockedApi).toHaveBeenLastCalledWith(expect.stringMatching(/sort=name.*order=desc/)));
  });

  it("renders linked breadcrumbs and drill-down paths", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "projects" })).toHaveAttribute("href", "/disk/projects");
    expect(screen.getByRole("link", { name: /src/ })).toHaveAttribute("href", "/disk/projects/demo/src");
  });

  it("ignores stale data after rapid path changes", async () => {
    const oldRequest = deferred<typeof result>();
    mockedApi.mockImplementation(async (path: string) => String(path).includes("projects%2Fdemo") ? oldRequest.promise : {
      ...result,
      current: { relativePath: "projects/next" },
      items: [{ name: "new.txt", relativePath: "projects/next/new.txt", type: "file", size: 100, percent: 100 }],
    });
    renderPage(true);
    await userEvent.click(screen.getByRole("button", { name: "Go to next path" }));
    expect(await screen.findByRole("cell", { name: /new\.txt/ })).toBeInTheDocument();
    await act(async () => { oldRequest.resolve(result); await oldRequest.promise; });
    expect(screen.queryByRole("cell", { name: /a\.txt/ })).not.toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /new\.txt/ })).toBeInTheDocument();
  });

  it("ignores a stale response after rapid sort changes", async () => {
    const oldSort = deferred<typeof result>();
    mockedApi.mockImplementation(async (path: string) => {
      const request = String(path);
      if (request.includes("sort=name")) return oldSort.promise;
      if (request.includes("sort=modified")) return {
        ...result,
        items: [{ name: "sorted.txt", relativePath: "projects/demo/sorted.txt", type: "file", size: 100, percent: 100 }],
      };
      return result;
    });
    renderPage();
    await screen.findByRole("cell", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: /Sort by name/i }));
    await waitFor(() => expect(mockedApi.mock.calls.some(([path]) => String(path).includes("sort=name"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Modified" }));
    expect(await screen.findByRole("cell", { name: /sorted\.txt/ })).toBeInTheDocument();
    await act(async () => { oldSort.resolve(result); await oldSort.promise; });
    expect(screen.queryByRole("cell", { name: /a\.txt/ })).not.toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /sorted\.txt/ })).toBeInTheDocument();
  });

  it("renders disk share as a CSP-safe progress element", async () => {
    renderPage();
    const progress = await screen.findByRole("progressbar", { name: "src disk share" });
    expect(progress).toHaveAttribute("value", "75");
    expect(progress).toHaveAttribute("max", "100");
    expect(progress).not.toHaveAttribute("style");
  });
});
