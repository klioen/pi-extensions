import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./types";

const message = (text: string, status: ChatMessage["status"] = "streaming"): ChatMessage => ({
  id: "assistant-1",
  role: "assistant",
  status,
  text,
});

function setGeometry(element: HTMLElement, { scrollHeight, clientHeight, scrollTop }: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

describe("MessageList live viewport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0)));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((handle: number) => window.clearTimeout(handle)));
  });

  afterEach(() => {
    act(() => vi.runAllTimers());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exposes the current conversation as a polite live log", () => {
    render(<MessageList messages={[message("hello")]} />);
    const viewport = screen.getByRole("log");
    expect(viewport).toHaveAttribute("aria-live", "polite");
    expect(viewport).toHaveAttribute("aria-relevant", "additions text");
  });

  it("keeps following within 48px and stops following when the user scrolls farther up", () => {
    const { rerender } = render(<MessageList messages={[message("a")]} />);
    const viewport = screen.getByRole("log");
    setGeometry(viewport, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 560 });
    fireEvent.scroll(viewport); // 40px from bottom: continue following

    rerender(<MessageList messages={[message("ab")]} />);
    act(() => vi.runAllTimers());
    expect(viewport.scrollTop).toBe(1_000);

    setGeometry(viewport, { scrollHeight: 1_200, clientHeight: 400, scrollTop: 740 });
    fireEvent.scroll(viewport); // 60px from bottom: user took control
    rerender(<MessageList messages={[message("abc")]} />);
    act(() => vi.runAllTimers());
    expect(viewport.scrollTop).toBe(740);
  });

  it("offers a jump control past 250px and clicking it resumes follow mode", () => {
    const { rerender } = render(<MessageList messages={[message("a")]} />);
    const viewport = screen.getByRole("log");
    setGeometry(viewport, { scrollHeight: 1_200, clientHeight: 400, scrollTop: 500 });
    fireEvent.scroll(viewport);

    const jump = screen.getByRole("button", { name: "滚动到底部" });
    fireEvent.click(jump);
    act(() => vi.runAllTimers());
    expect(viewport.scrollTop).toBe(1_200);
    expect(screen.queryByRole("button", { name: "滚动到底部" })).not.toBeInTheDocument();

    setGeometry(viewport, { scrollHeight: 1_400, clientHeight: 400, scrollTop: 1_000 });
    rerender(<MessageList messages={[message("finished", "done")]} />);
    act(() => vi.runAllTimers());
    expect(viewport.scrollTop).toBe(1_400);
  });

  it("uses a frame plus finite delayed corrections and cleans pending work on unmount", () => {
    const { unmount } = render(<MessageList messages={[message("stream")]} />);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
