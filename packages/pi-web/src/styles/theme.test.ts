/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import tokens from "./tokens.less?raw";

function themeBlock(name: "light" | "dark") {
  const start = tokens.indexOf(`:root[data-theme="${name}"]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = tokens.indexOf("{", start);
  const bodyEnd = tokens.indexOf("\n}", bodyStart);
  return tokens.slice(bodyStart + 1, bodyEnd);
}

function tokenNames(block: string) {
  return new Set([...block.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]));
}

describe("theme tokens", () => {
  it("defines every light semantic color token for dark mode and retains the muted alias", () => {
    const light = tokenNames(themeBlock("light"));
    const dark = tokenNames(themeBlock("dark"));
    const inheritedLayoutTokens = new Set(["muted", "control-border", "interactive-subtle", "selected", "code-bg", "radius-nav", "radius-card", "radius-panel", "sidebar-width", "sidebar-collapsed-width", "header-height", "sans", "mono"]);
    expect([...light].filter((token) => !inheritedLayoutTokens.has(token) && !dark.has(token))).toEqual([]);
    expect(tokens).toContain("--muted: var(--text-muted)");
  });

  it("keeps page, chat, and layout styles free of theme-specific color literals", () => {
    const files = import.meta.glob<string>(["../pages/**/*.less", "../chat/**/*.less", "../layout/**/*.less"], { eager: true, query: "?raw", import: "default" });
    for (const [file, css] of Object.entries(files)) {
      expect(css, file).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });
});
