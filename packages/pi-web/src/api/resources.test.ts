import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import { getProjects, getSessions, projectKey } from "./resources";

describe("session resources", () => {
  it("returns every normalized session without truncating the response", async () => {
    const sessions = Array.from({ length: 10 }, (_, index) => ({ sessionId: `session-${index}`, cwd: `/work/project-${index}` }));
    const client = vi.fn().mockResolvedValue({ sessions }) as unknown as ApiClient;

    const result = await getSessions(client);

    expect(result).toHaveLength(10);
    expect(result[9]).toMatchObject({ id: "session-9", cwd: "/work/project-9" });
  });

  it("deduplicates projects by complete cwd and sorts them by latest modification", async () => {
    const client = vi.fn().mockResolvedValue({ sessions: [
      { id: "older", cwd: "/Users/dev/Code/alpha", modified: "2026-01-01T00:00:00Z" },
      { id: "newer", cwd: "/Users/dev/Code/alpha", modified: "2026-01-03T00:00:00Z" },
      { id: "beta", cwd: "/Users/dev/Code/beta", modified: "2026-01-02T00:00:00Z" },
      { id: "unknown", messageCount: 4, modified: "2026-01-04T00:00:00Z" },
    ] }) as unknown as ApiClient;

    await expect(getProjects(client)).resolves.toEqual([
      { key: projectKey({}), cwd: "", label: "Unknown project", modified: "2026-01-04T00:00:00Z" },
      { key: projectKey({ cwd: "/Users/dev/Code/alpha" }), cwd: "/Users/dev/Code/alpha", label: "alpha", modified: "2026-01-03T00:00:00Z" },
      { key: projectKey({ cwd: "/Users/dev/Code/beta" }), cwd: "/Users/dev/Code/beta", label: "beta", modified: "2026-01-02T00:00:00Z" },
    ]);
  });
});
