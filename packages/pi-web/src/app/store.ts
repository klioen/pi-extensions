import { proxy } from "valtio";
import type { Project } from "../api/types";

export type ThemePreference = "light" | "dark" | "system";
export type ConnectionStatus = "connecting" | "online" | "offline";
export type ToastTone = "info" | "success" | "error";

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
}

const THEME_KEY = "pi-web-theme";
const SIDEBAR_KEY = "pi-web-sidebar";

function storageValue(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function initialTheme(): ThemePreference {
  const value = storageValue(THEME_KEY);
  return value === "dark" || value === "system" ? value : "light";
}

function initialSidebarCollapsed(): boolean {
  return storageValue(SIDEBAR_KEY) === "collapsed";
}

export const appStore = proxy({
  theme: initialTheme() as ThemePreference,
  sidebarCollapsed: initialSidebarCollapsed(),
  mobileMenuOpen: false,
  connection: "connecting" as ConnectionStatus,
  projects: [] as Project[],
  projectsLoading: false,
  projectsError: "" as string,
  toasts: [] as ToastMessage[],
});

export function effectiveTheme(theme: ThemePreference, prefersDark = false): "light" | "dark" {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

export function applyTheme(theme = appStore.theme): void {
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  document.documentElement.dataset.theme = effectiveTheme(theme, prefersDark);
}

export function setTheme(theme: ThemePreference): void {
  appStore.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage may be unavailable */ }
  applyTheme(theme);
}

export function setSidebarCollapsed(collapsed: boolean): void {
  appStore.sidebarCollapsed = collapsed;
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* storage may be unavailable */ }
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!appStore.sidebarCollapsed);
}

export function setMobileMenu(open: boolean): void {
  appStore.mobileMenuOpen = open;
}

export function setConnection(connected: boolean): void {
  appStore.connection = connected ? "online" : "offline";
}

export function setProjects(projects: Project[]): void {
  appStore.projects = projects;
  appStore.projectsError = "";
}

export function addToast(message: string, tone: ToastTone = "info"): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  appStore.toasts.push({ id, message, tone });
  return id;
}

export function dismissToast(id: string): void {
  const index = appStore.toasts.findIndex((toast) => toast.id === id);
  if (index >= 0) appStore.toasts.splice(index, 1);
}

export function resetAppStore(): void {
  appStore.theme = "light";
  appStore.sidebarCollapsed = false;
  appStore.mobileMenuOpen = false;
  appStore.connection = "connecting";
  appStore.projects = [];
  appStore.projectsLoading = false;
  appStore.projectsError = "";
  appStore.toasts = [];
}
