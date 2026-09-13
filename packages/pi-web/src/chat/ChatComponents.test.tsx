import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChatPage from "./ChatPage";
import Composer from "./Composer";
import MessageList from "./MessageList";
import { useChatRuntime } from "./useChatRuntime";

function RuntimeProbe({ request }: { request: (path: string) => Promise<unknown> }) {
  const { state } = useChatRuntime({
    request,
    createEventSource: () => ({ onopen: null, onerror: null, addEventListener: () => undefined, close: () => undefined }),
  });
  return <output>{state.phase}</output>;
}

describe("useChatRuntime", () => {
  it("creates a fresh runtime for the second StrictMode effect setup", async () => {
    const request = vi.fn((path: string) => Promise.resolve(path.endsWith("snapshot")
      ? { available: true, currentSessionId: "s1", eventCursor: 0 }
      : { sessionId: "s1", entries: [] }));
    render(<StrictMode><RuntimeProbe request={request} /></StrictMode>);
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(request.mock.calls.filter(([path]) => path === "/api/chat/snapshot")).toHaveLength(2);
  });
});

describe("ChatKit-equivalent message flow", () => {
  it("groups adjacent tools behind one generic collapsed execution summary", () => {
    render(<MessageList messages={[
      { id: "assistant-1", role: "assistant", status: "done", text: "Checking files" },
      { id: "tool-1", role: "tool", status: "done", toolName: "read", arguments: { path: "secret-a" }, result: "first-result" },
      { id: "tool-2", role: "tool", status: "done", toolName: "grep", arguments: { query: "needle" }, result: "second-result" },
      { id: "assistant-2", role: "assistant", status: "done", text: "Finished" },
    ]} />);
    const summary = screen.getByRole("button", { name: /执行过程/ });
    expect(screen.getAllByRole("button", { name: /执行过程/ })).toHaveLength(1);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    expect(screen.queryByText("grep")).not.toBeInTheDocument();
    expect(screen.queryByText(/secret-a/)).not.toBeInTheDocument();
    expect(screen.queryByText("first-result")).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
    expect(screen.getByText(/secret-a/)).toBeInTheDocument();
    expect(screen.getByText("second-result")).toBeInTheDocument();
  });

  it("expands running tool details and collapses them after completion", () => {
    const tool = { id: "tool-1", role: "tool", status: "running" as const, toolName: "bash", arguments: { command: "pwd" } };
    const { rerender } = render(<MessageList messages={[tool]} />);
    expect(screen.getByRole("button", { name: /正在执行/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("bash")).toBeInTheDocument();
    rerender(<MessageList messages={[{ ...tool, status: "done", result: "ok" }]} />);
    expect(screen.getByRole("button", { name: /执行过程/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("bash")).not.toBeInTheDocument();
  });
});

describe("ChatPage states", () => {
  it("shows a loading skeleton without rendering the welcome state", () => {
    render(<ChatPage runtimeOptions={{ request: () => new Promise(() => undefined) }} />);
    expect(screen.getByLabelText("正在加载对话")).toBeInTheDocument();
    expect(screen.queryByText("和当前 Pi Session 对话")).not.toBeInTheDocument();
  });

  it("shows an explanatory empty state without a message list or composer when runtime is unavailable", async () => {
    const request = vi.fn(() => Promise.resolve({ available: false, eventCursor: 0 }));
    render(<ChatPage runtimeOptions={{
      request,
      createEventSource: () => ({ onopen: null, onerror: null, addEventListener: () => undefined, close: () => undefined }),
    }} />);
    await waitFor(() => expect(screen.getByText("当前没有可用的 Pi Session")).toBeInTheDocument());
    expect(screen.getByText("请先在 Pi 中打开一个 Session，然后返回此处继续对话。")).toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("发送消息")).not.toBeInTheDocument();
  });

  it("integrates session and connection state in the subheader and centers the hero composer when empty", async () => {
    let source: { onopen: null | (() => void); onerror: null; addEventListener: () => undefined; close: () => undefined } | undefined;
    const request = vi.fn((path: string) => Promise.resolve(path.endsWith("snapshot")
      ? { available: true, currentSessionId: "s1", sessionName: "Focused session", eventCursor: 0 }
      : { sessionId: "s1", entries: [] }));
    render(<ChatPage runtimeOptions={{
      request,
      createEventSource: () => (source = { onopen: null, onerror: null, addEventListener: () => undefined, close: () => undefined }),
    }} />);
    await waitFor(() => expect(screen.getByText("Focused session")).toBeInTheDocument());
    source?.onopen?.();
    await waitFor(() => expect(screen.getByText("已连接")).toBeInTheDocument());
    expect(screen.getByRole("banner", { name: "对话状态" })).toHaveTextContent("空闲");
    expect(screen.getByText("和当前 Pi Session 对话")).toBeInTheDocument();
    expect(screen.getByLabelText("发送消息").closest("form")).toHaveAttribute("data-variant", "hero");
  });
});

describe("Composer", () => {
  it("sends with Enter and preserves Shift+Enter as a newline", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} onStop={vi.fn()} />);
    const input = screen.getByLabelText("发送消息");
    await user.type(input, "hello{shift>}{enter}{/shift}world");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("hello\nworld");
    await user.type(input, "{enter}");
    expect(onSend).toHaveBeenCalledWith("hello\nworld");
  });

  it("disables all composer actions while disconnected", () => {
    render(<Composer disabled running onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByLabelText("发送消息")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it.each(["click", "enter"] as const)("stops the active run for an empty draft by %s", async (method) => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(<Composer running onSend={onSend} onStop={onStop} />);
    if (method === "click") await user.click(screen.getByRole("button", { name: "Stop" }));
    else await user.type(screen.getByLabelText("发送消息"), "{enter}");
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each(["click", "enter"] as const)("sends a running draft as follow-up by %s", async (method) => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    render(<Composer running onSend={onSend} onStop={onStop} />);
    const input = screen.getByLabelText("发送消息");
    await user.type(input, "next step");
    expect(screen.getByRole("button", { name: "发送 follow-up" })).toBeEnabled();
    if (method === "click") await user.click(screen.getByRole("button", { name: "发送 follow-up" }));
    else await user.type(input, "{enter}");
    expect(onSend).toHaveBeenCalledWith("next step");
    expect(onStop).not.toHaveBeenCalled();
  });

  it("exposes hero and compact visual variants without changing its callbacks", () => {
    const props = { onSend: vi.fn(), onStop: vi.fn() };
    const { container, rerender } = render(<Composer {...props} variant="hero" />);
    expect(container.firstElementChild).toHaveAttribute("data-variant", "hero");
    rerender(<Composer {...props} variant="compact" />);
    expect(container.firstElementChild).toHaveAttribute("data-variant", "compact");
  });
});
