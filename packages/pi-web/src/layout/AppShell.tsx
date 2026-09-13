import { useEffect, useRef, type ReactNode } from "react";
import { useSnapshot } from "valtio";
import { createApiClient } from "../api/client";
import { appStore, applyTheme, setConnection, setMobileMenu } from "../app/store";
import { ToastRegion } from "../components/ToastRegion";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import styles from "./AppShell.module.less";

export function AppShell({ children }: { children: ReactNode }) {
  const state = useSnapshot(appStore);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    applyTheme();
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => { if (appStore.theme === "system") applyTheme("system"); };
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    createApiClient({ onConnectionChange: setConnection })("/api/overview").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!state.mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileMenu(false);
      mobileMenuTriggerRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [state.mobileMenuOpen]);

  return <div className={`${styles.shell} ${state.sidebarCollapsed ? styles.collapsed : ""}`}>
    <a className={styles.skipLink} href="#main-content">Skip to content</a>
    <Sidebar />
    <div className={styles.workspace}>
      <Header mobileMenuTriggerRef={mobileMenuTriggerRef} />
      <main id="main-content" className={styles.main} tabIndex={-1}>{children}</main>
    </div>
    <ToastRegion />
  </div>;
}
