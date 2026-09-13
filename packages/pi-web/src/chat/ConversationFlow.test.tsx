import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConversationFlow from "./ConversationFlow";
import conversationCss from "./ConversationFlow.module.less?raw";
import chatPageCss from "./ChatPage.module.less?raw";
import messageListCss from "./MessageList.module.less?raw";
import sessionsPageCss from "../pages/SessionsPage.module.less?raw";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

describe("ConversationFlow shared message layer", () => {
  it("contains wide chat content without horizontal scrolling", () => {
    expect(conversationCss).toMatch(/\.flow\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(conversationCss).toMatch(/\.markdown table\s*\{[^}]*table-layout:\s*fixed/s);
    expect(conversationCss).toMatch(/\.markdown th, \.markdown td\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(conversationCss).toMatch(/\.codeBlock pre\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(conversationCss).toMatch(/\.codeBlock code\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(messageListCss).toMatch(/\.transcript\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(chatPageCss).toMatch(/\.workbench\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(sessionsPageCss).toMatch(/\.detail\s*\{[^}]*overflow-x:\s*hidden/s);
  });

  it("uses matching collapsed and expanded widths for reasoning and tool groups", () => {
    expect(conversationCss).toMatch(/\.reasoning, \.toolGroup\s*\{[^}]*width:\s*min\(560px, 100%\)[^}]*transition:\s*width 160ms ease/s);
    expect(conversationCss).toMatch(/\.reasoningExpanded, \.toolGroupExpanded\s*\{[^}]*width:\s*min\(var\(--chat-thread-width, 960px\), 100%\)/s);
    expect(conversationCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.reasoning, \.toolGroup\s*\{[^}]*transition:\s*none/s);
  });

  it("renders safe assistant GFM and copies fenced code", () => {
    render(<ConversationFlow messages={[{
      id: "assistant-1",
      role: "assistant",
      status: "done",
      text: [
        "# Heading",
        "",
        "- first",
        "- second with `inline()`",
        "",
        "> quoted",
        "",
        "[Pi](https://example.com)",
        "",
        "| Name | State |",
        "| --- | --- |",
        "| build | green |",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "<script>alert('unsafe')</script>",
      ].join("\n"),
    }]} />);

    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("quoted").closest("blockquote")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pi" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("table")).toHaveTextContent("buildgreen");
    expect(screen.getByText("inline()").tagName).toBe("CODE");
    expect(document.querySelector("script")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const value = 1;\n");
  });

  it("renders minimal messages with bottom metadata and no role or message-copy chrome", () => {
    render(<ConversationFlow messages={[
      { id: "user-1", role: "user", status: "queued", text: "hello", timestamp: "2026-09-12T08:30:00.000Z" },
      { id: "assistant-1", role: "assistant", status: "done", text: "welcome" },
    ]} />);

    const article = screen.getByText("hello").closest("article");
    expect(article).toHaveAttribute("data-role", "user");
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("Pi")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    const time = article?.querySelector("time");
    if (!time) throw new Error("Expected bottom timestamp");
    expect(time).toHaveAttribute("dateTime", "2026-09-12T08:30:00.000Z");
    expect(time.parentElement?.className).toContain("messageMeta");
    expect(conversationCss).toMatch(/\.messageMeta time\s*\{[^}]*opacity:\s*0[^}]*visibility:\s*hidden/s);
    expect(conversationCss).toMatch(/\.message:hover \.messageMeta time, \.message:focus-within \.messageMeta time\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/s);
  });

  it("keeps rendering when a message timestamp is malformed", () => {
    render(<ConversationFlow messages={[{ id: "bad-time", role: "assistant", text: "still visible", timestamp: "not-a-date" }]} />);
    const article = screen.getByText("still visible").closest("article");
    expect(article?.querySelector("time")).not.toHaveAttribute("dateTime");
  });

  it("does not claim clipboard success when clipboard access is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<ConversationFlow messages={[{ id: "code", role: "assistant", text: "```js\nconst x = 1;\n```" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByText("Copy unavailable")).toBeInTheDocument();
  });

  it("shows completed reasoning collapsed and keeps assistant errors inline", () => {
    render(<ConversationFlow messages={[
      { id: "reasoning", role: "reasoning", text: "Check **constraints**", status: "done" },
      { id: "assistant", role: "assistant", text: "Partial answer", error: "Connection lost" },
    ]} />);

    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.closest("section")?.className).not.toContain("reasoningExpanded");
    expect(screen.queryByText("constraints")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle.closest("section")?.className).toContain("reasoningExpanded");
    expect(screen.getByText("constraints")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  });

  it("shows running reasoning expanded and marks it as thinking", () => {
    render(<ConversationFlow messages={[{ id: "reasoning", role: "reasoning", text: "Checking", status: "streaming" }]} />);
    expect(screen.getByRole("button", { name: "思考中" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking")).toBeInTheDocument();
  });

  it("preserves expanded reasoning within a session and resets it for another session", () => {
    const { rerender } = render(<ConversationFlow scopeKey="session-1" messages={[{ id: "reasoning-live", role: "reasoning", text: "Checking constraints", status: "done" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.getByRole("button", { name: "思考过程" })).toHaveAttribute("aria-expanded", "true");
    rerender(<ConversationFlow scopeKey="session-1" messages={[{ id: "history-entry-thinking-0", role: "reasoning", text: "Checking constraints", status: "done" }]} />);
    expect(screen.getByRole("button", { name: "思考过程" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking constraints")).toBeInTheDocument();
    rerender(<ConversationFlow scopeKey="session-2" messages={[{ id: "another-thinking", role: "reasoning", text: "Different session", status: "done" }]} />);
    expect(screen.getByRole("button", { name: "思考过程" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Different session")).not.toBeInTheDocument();
  });

  it("auto-expands running tools, auto-collapses terminal tools, and nests payload details", () => {
    const running = { id: "tool-1", role: "tool", status: "running", toolName: "bash", arguments: { command: "pwd" } };
    const { rerender } = render(<ConversationFlow messages={[running]} />);

    const summary = screen.getByRole("button", { name: /正在执行/ });
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(summary.closest("section")?.className).toContain("toolGroupExpanded");
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("Arguments").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText(/"command": "pwd"/)).not.toBeVisible();

    rerender(<ConversationFlow messages={[{ ...running, status: "done", result: "ok" }]} />);
    const completedSummary = screen.getByRole("button", { name: /执行过程/ });
    expect(completedSummary).toHaveAttribute("aria-expanded", "false");
    expect(completedSummary.closest("section")?.className).not.toContain("toolGroupExpanded");
    expect(screen.queryByText("bash")).not.toBeInTheDocument();
  });
});
