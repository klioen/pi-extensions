import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExtensionsPage from "./ExtensionsPage";
import OverviewPage from "./OverviewPage";
import SessionsPage from "./SessionsPage";
import SkillsPage from "./SkillsPage";
import { projectKey } from "../api/resources";
import { ApiError, type ApiRequest } from "./shared/request";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function injected(handler: (path: string, options?: Parameters<ApiRequest>[1]) => unknown | Promise<unknown>): ApiRequest {
  return ((path: string, options?: Parameters<ApiRequest>[1]) => Promise.resolve(handler(path, options))) as ApiRequest;
}

const sessionList = {
  sessions: [{ id: "s1", name: "Demo", cwd: "/project", messageCount: 2, modified: "2026-01-01T00:00:00Z", current: true }],
  tree: [{ id: "root", name: "directory tree must stay hidden", sessionCount: 1, modified: "2026-01-01T00:00:00Z", children: [], sessions: [{ id: "s1", name: "Demo", cwd: "/project", messageCount: 2, current: true }] }],
};
const defaultProjectId = projectKey({ cwd: "/project" });
const sessionDetail = {
  session: { id: "s1", name: "Demo", current: true }, current: true, revision: "rev-1", sourceTruncated: false,
  summary: { totalEntries: 4 }, chatHistory: [
    { id: "m1", role: "user", content: "Hello" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "Hi" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }, { type: "toolCall", id: "t2", name: "grep", arguments: { query: "needle" } }] },
    { id: "r1", role: "toolResult", toolCallId: "t1", toolName: "read", content: "one" },
    { id: "r2", role: "toolResult", toolCallId: "t2", toolName: "grep", content: "two" },
  ],
};

describe("core management pages", () => {
  it("renders overview metrics and recent sessions", async () => {
    render(<OverviewPage request={injected(() => ({ counts: { sessions: 4, skills: 3, extensions: 2, packages: 1 }, memory: { summary: true }, recentSessions: [{ id: "s1", name: "Demo" }], cwd: "/project", projectTrusted: true }))} />);
    expect(await screen.findByRole("heading", { name: "System overview" })).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Demo/ })).toHaveAttribute("href", "#/sessions/s1");
  });

  it("selects a complete cwd project, shows only its flat sessions, and never renders the directory tree", async () => {
    const list = {
      sessions: [
        { id: "a1", name: "Alpha one", cwd: "/work/alpha" },
        { id: "a2", name: "Alpha two", cwd: "/work/alpha" },
        { id: "b1", name: "Beta one", cwd: "/work/beta" },
      ],
      tree: [{ id: "root", name: "Users", sessionCount: 3, children: [{ id: "secret", name: "recursive-folder", sessionCount: 3, children: [], sessions: [] }], sessions: [] }],
    };
    const request = injected((path) => path.startsWith("/api/sessions/")
      ? { session: list.sessions.find((session) => path.endsWith(session.id)), chatHistory: [] }
      : list);
    const { rerender } = render(<SessionsPage request={request} initialProject={projectKey({ cwd: "/work/beta" })} />);
    expect(await screen.findByRole("button", { name: /Beta one/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Sessions in \/work\/beta/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Alpha one/ })).not.toBeInTheDocument();
    expect(screen.queryByText("recursive-folder")).not.toBeInTheDocument();

    rerender(<SessionsPage request={request} initialProject={projectKey({ cwd: "/work/alpha" })} />);
    expect(await screen.findByRole("button", { name: /Alpha one/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alpha two/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta one/ })).not.toBeInTheDocument();
  });

  it("uses the selected route session cwd before the first stable project", async () => {
    const list = {
      sessions: [{ id: "a", name: "Alpha", cwd: "/a" }, { id: "z", name: "Zulu", cwd: "/z" }],
      tree: [],
    };
    render(<SessionsPage initialSessionId="z" request={injected((path) => path === "/api/sessions/z" ? { session: list.sessions[1], chatHistory: [] } : list)} />);
    expect(await screen.findByRole("button", { name: /Zulu/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Alpha/ })).not.toBeInTheDocument();
  });

  it("groups sessions without cwd under the selectable Unknown project", async () => {
    render(<SessionsPage initialProject={projectKey({})} request={injected(() => ({ sessions: [{ id: "orphan", name: "Orphan" }], tree: [] }))} />);
    expect(await screen.findByRole("button", { name: /Orphan/ })).toBeInTheDocument();
  });

  it("clears the selected project when the route project is removed", async () => {
    const { rerender } = render(<SessionsPage request={injected(() => sessionList)} initialProject={defaultProjectId} />);
    expect(await screen.findByRole("button", { name: /Demo/ })).toBeInTheDocument();
    rerender(<SessionsPage request={injected(() => sessionList)} initialProject="" />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Demo/ })).not.toBeInTheDocument());
    expect(screen.getByText("No sessions found for this project.")).toBeInTheDocument();
  });

  it("loads transcript, folds tools, protects current deletion, and keeps the workspace conversation-only", async () => {
    const request = injected((path) => path === "/api/sessions/s1" ? sessionDetail : sessionList);
    render(<SessionsPage request={request} initialProject={defaultProjectId} />);
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: /Demo/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sessions in /project")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search sessions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Demo/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.queryByText(/technical details/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Statistics")).not.toBeInTheDocument();
    expect(screen.queryByText("Diagnostics")).not.toBeInTheDocument();
    const toolGroup = screen.getByRole("button", { name: /执行过程/ });
    expect(toolGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    expect(screen.queryByText("grep")).not.toBeInTheDocument();
    await user.click(toolGroup);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Actions for Demo"));
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("syncs changed session route params without overwriting an internal selection", async () => {
    const list = {
      sessions: [{ id: "s1", name: "One", cwd: "/project" }, { id: "s2", name: "Two", cwd: "/project" }, { id: "s3", name: "Three", cwd: "/project" }],
      tree: [{ id: "root", name: "project", sessionCount: 3, children: [], sessions: [{ id: "s1", name: "One", cwd: "/project" }, { id: "s2", name: "Two", cwd: "/project" }, { id: "s3", name: "Three", cwd: "/project" }] }],
    };
    const request = injected((path) => path.startsWith("/api/sessions/")
      ? { session: { id: path.slice(path.lastIndexOf("/") + 1), name: path.endsWith("s3") ? "Three" : path.endsWith("s2") ? "Two" : "One" }, entries: [] }
      : list);
    const { rerender } = render(<SessionsPage request={request} initialSessionId="s1" />);
    expect(await screen.findByRole("heading", { name: "One" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Two/ }));
    expect(await screen.findByRole("heading", { name: "Two" })).toBeInTheDocument();
    rerender(<SessionsPage request={request} initialSessionId="s1" />);
    expect(screen.getByRole("heading", { name: "Two" })).toBeInTheDocument();
    rerender(<SessionsPage request={request} initialSessionId="s3" />);
    expect(await screen.findByRole("heading", { name: "Three" })).toBeInTheDocument();
  });

  it("retries a failed session detail request", async () => {
    let attempts = 0;
    const request = injected((path) => {
      if (path === "/api/sessions/s1" && ++attempts === 1) return Promise.reject(new Error("detail offline"));
      return path === "/api/sessions/s1" ? sessionDetail : sessionList;
    });
    render(<SessionsPage request={request} initialSessionId="s1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("renames a historical session with the latest revision and updates the open chat title", async () => {
    const patch = vi.fn();
    const request = injected((path, options) => {
      if (options?.method === "PATCH") { patch(options.body); return { revision: "rev-2" }; }
      if (path === "/api/sessions/s1") return { ...sessionDetail, session: { ...sessionDetail.session, current: false } };
      return { ...sessionList, sessions: [{ ...sessionList.sessions[0], current: false }], tree: [{ ...sessionList.tree[0], sessions: [{ ...sessionList.sessions[0], current: false }] }] };
    });
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    render(<SessionsPage request={request} initialProject={defaultProjectId} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Demo/ }));
    await user.click(await screen.findByLabelText("Actions for Demo"));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ name: "Renamed", revision: "rev-1" }));
    expect(screen.getByRole("heading", { name: "Renamed" })).toBeInTheDocument();
  });

  it("refreshes the full session catalog and sidebar after a mutation", async () => {
    const historical = { ...sessionList.sessions[0], current: false };
    let listRequests = 0;
    const changed = vi.fn();
    window.addEventListener("pi-web:sessions-changed", changed);
    const request = injected((path, options) => {
      if (options?.method === "PATCH") return { revision: "rev-2" };
      if (path === "/api/sessions/s1") return { ...sessionDetail, session: historical };
      if (path === "/api/sessions") { listRequests += 1; return { sessions: [historical] }; }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    render(<SessionsPage request={request} initialProject={defaultProjectId} />);
    const user = userEvent.setup();
    const actions = await screen.findByLabelText("Actions for Demo");
    await user.click(actions);
    await user.click(within(actions.parentElement!).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(listRequests).toBe(2));
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener("pi-web:sessions-changed", changed);
  });

  it("notifies the router after deleting the selected historical session", async () => {
    const onSessionChange = vi.fn();
    const historical = { ...sessionList.sessions[0], current: false };
    const request = injected((path, options) => {
      if (options?.method === "DELETE") return { deleted: true };
      if (path === "/api/sessions/s1") return { ...sessionDetail, session: historical };
      return { sessions: [historical] };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SessionsPage request={request} initialProject={defaultProjectId} initialSessionId="s1" onSessionChange={onSessionChange} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Actions for Demo"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onSessionChange).toHaveBeenCalledWith("", defaultProjectId));
  });

  it("edits a writable skill and reports revision conflicts", async () => {
    let put = false;
    const skill = { id: "demo", name: "demo", description: "Demo skill", mutable: true, revision: "rev-1", scope: "user", diagnostics: [] };
    const request = injected((path, options) => {
      if (options?.method === "PUT") { put = true; return Promise.reject(new ApiError(409, "changed", {})); }
      if (path === "/api/skills/demo") return { skill, content: "# Demo" };
      return { skills: [skill, { id: "readonly", name: "readonly", mutable: false }] };
    });
    render(<SkillsPage request={request} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /demo editable/ }));
    const editor = await screen.findByRole("textbox", { name: "Skill Markdown content" });
    await user.clear(editor); await user.type(editor, "# Changed");
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    expect(await screen.findByText(/Revision conflict/)).toBeInTheDocument();
    expect(put).toBe(true);
  });

  it("syncs changed skill route params, preserves user selection, and retries detail", async () => {
    const skills = [{ id: "one", name: "one", mutable: false }, { id: "two", name: "two", mutable: false }, { id: "three", name: "three", mutable: false }];
    let twoAttempts = 0;
    const request = injected((path) => {
      if (path === "/api/skills/two" && ++twoAttempts === 1) return Promise.reject(new Error("detail offline"));
      if (path.startsWith("/api/skills/")) {
        const id = path.endsWith("three") ? "three" : path.endsWith("two") ? "two" : "one";
        return { skill: skills.find((skill) => skill.id === id), content: `# ${id}` };
      }
      return { skills };
    });
    const { rerender } = render(<SkillsPage request={request} initialSkillId="one" />);
    expect(await screen.findByRole("heading", { name: "one" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /two read only/ }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "two" })).toBeInTheDocument();
    expect(twoAttempts).toBe(2);
    rerender(<SkillsPage request={request} initialSkillId="one" />);
    expect(screen.getByRole("heading", { name: "two" })).toBeInTheDocument();
    rerender(<SkillsPage request={request} initialSkillId="three" />);
    expect(await screen.findByRole("heading", { name: "three" })).toBeInTheDocument();
  });

  it("keeps readonly skills immutable and renders extension and package inventories", async () => {
    const readonly = { id: "readonly", name: "readonly", mutable: false, revision: "rev" };
    const { unmount } = render(<SkillsPage initialSkillId="readonly" request={injected((path) => path === "/api/skills/readonly" ? { skill: readonly, content: "# Readonly" } : { skills: [readonly] })} />);
    expect(await screen.findByRole("textbox", { name: "Skill Markdown content" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save revision" })).not.toBeInTheDocument();
    unmount();
    render(<ExtensionsPage request={injected(() => ({ entries: [{ name: "local-ext", scope: "project", path: ".pi/extensions/local.ts" }], settings: { packages: ["npm:demo"], extensionPaths: ["./extra"] } }))} />);
    expect(await screen.findByText("local-ext")).toBeInTheDocument();
    expect(screen.getByText("npm:demo")).toBeInTheDocument();
    expect(within(screen.getByRole("heading", { name: "Configured paths" }).parentElement!.parentElement!).getByText("./extra")).toBeInTheDocument();
  });
});
