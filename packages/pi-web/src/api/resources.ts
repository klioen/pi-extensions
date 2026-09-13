import { apiClient, type ApiClient } from "./client";
import type { Project, SessionSummary, SessionsResponse } from "./types";

function normalizeSession(item: SessionSummary): SessionSummary | null {
  const id = item.id || (item as SessionSummary & { sessionId?: string }).sessionId;
  return id ? { ...item, id } : null;
}

function modifiedTime(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function projectKey(session: Pick<SessionSummary, "cwd" | "projectId">): string {
  if (session.projectId) return session.projectId;
  const value = session.cwd || "";
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return `project-${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function projectLabel(cwd: string): string {
  if (!cwd) return "Unknown project";
  const withoutTrailingSeparators = cwd.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.split(/[\\/]/).pop() || cwd;
}

export async function getSessions(client: ApiClient = apiClient): Promise<SessionSummary[]> {
  const response = await client<SessionsResponse | SessionSummary[]>("/api/sessions");
  const values = Array.isArray(response)
    ? response
    : response.sessions ?? response.items ?? response.results ?? [];
  return values.map(normalizeSession).filter((item): item is SessionSummary => item !== null);
}

export async function getProjects(client: ApiClient = apiClient): Promise<Project[]> {
  const projects = new Map<string, Project>();
  for (const session of await getSessions(client)) {
    const cwd = typeof session.cwd === "string" && session.cwd.trim() ? session.cwd : "";
    const key = projectKey(session);
    const modified = session.modified ?? session.updatedAt;
    const current = projects.get(key);
    if (!current || modifiedTime(modified) > modifiedTime(current.modified)) {
      projects.set(key, { key, cwd, label: projectLabel(cwd), modified });
    }
  }
  return [...projects.values()].sort((left, right) =>
    modifiedTime(right.modified) - modifiedTime(left.modified) || left.key.localeCompare(right.key),
  );
}
