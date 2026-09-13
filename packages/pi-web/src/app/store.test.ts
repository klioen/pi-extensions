import { beforeEach, describe, expect, it } from "vitest";
import { appStore, resetAppStore, setProjects, setSidebarCollapsed, setTheme } from "./store";

describe("app store", () => {
  beforeEach(() => { localStorage.clear(); resetAppStore(); });

  it("persists and applies theme", () => {
    setTheme("dark");
    expect(appStore.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("pi-web-theme")).toBe("dark");
  });

  it("persists sidebar preference", () => {
    setSidebarCollapsed(true);
    expect(appStore.sidebarCollapsed).toBe(true);
    expect(localStorage.getItem("pi-web-sidebar")).toBe("collapsed");
  });

  it("stores projects", () => {
    setProjects([{ key: "/work/foundation", cwd: "/work/foundation", label: "foundation", modified: 2 }]);
    expect(appStore.projects).toEqual([{ key: "/work/foundation", cwd: "/work/foundation", label: "foundation", modified: 2 }]);
    expect(appStore.projectsError).toBe("");
  });
});
