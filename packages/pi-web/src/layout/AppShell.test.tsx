import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../app/App";
import { appStore, resetAppStore } from "../app/store";

vi.mock("../api/resources", () => ({
  getProjects: vi.fn().mockResolvedValue([
    { key: "project-foundation", cwd: "/work/foundation", label: "foundation", modified: 3 },
    { key: "project-another", cwd: "/archive/foundation", label: "foundation", modified: 2 },
  ]),
}));

beforeEach(() => {
  localStorage.clear();
  resetAppStore();
  window.location.hash = "#/overview";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("toggles and persists the desktop sidebar", async () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    await userEvent.click(toggle);
    expect(appStore.sidebarCollapsed).toBe(true);
    expect(localStorage.getItem("pi-web-sidebar")).toBe("collapsed");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("loads projects and navigates from the sidebar using the complete cwd", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Projects", level: 2 })).toBeInTheDocument();
    const project = await screen.findByTitle("/work/foundation");
    expect(screen.getByTitle("/archive/foundation")).toBeInTheDocument();
    appStore.mobileMenuOpen = true;
    await userEvent.click(project);
    await waitFor(() => expect(window.location.hash).toBe("#/sessions?project=project-foundation"));
    expect(appStore.mobileMenuOpen).toBe(false);
  });

  it("opens and closes the mobile navigation menu", async () => {
    render(<App />);
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
    expect(menu).not.toBeNull();
    fireEvent.click(menu!);
    await waitFor(() => expect(appStore.mobileMenuOpen).toBe(true));
    expect(document.querySelector('button[aria-label="Open navigation"]')).toHaveAttribute("aria-expanded", "true");
    const scrim = document.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    await waitFor(() => expect(appStore.mobileMenuOpen).toBe(false));
  });

  it("closes mobile navigation with Escape and returns focus to its trigger", async () => {
    render(<App />);
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
    expect(menu).not.toBeNull();
    menu!.focus();
    await userEvent.click(menu!);
    expect(appStore.mobileMenuOpen).toBe(true);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(appStore.mobileMenuOpen).toBe(false));
    expect(menu).toHaveFocus();
  });

  it("switches theme from the header", async () => {
    render(<App />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Color theme" }), "dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
