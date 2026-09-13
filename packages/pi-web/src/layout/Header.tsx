import type { RefObject } from "react";
import { useLocation } from "react-router-dom";
import { useSnapshot } from "valtio";
import { appStore, setMobileMenu, setTheme, type ThemePreference } from "../app/store";
import styles from "./Header.module.less";

const titles: Record<string, string> = {
  overview: "Overview",
  chat: "Chat",
  sessions: "Sessions",
  skills: "Skills",
  extensions: "Extensions",
  disk: "Disk Usage",
  memory: "Memory",
};

export function Header({ mobileMenuTriggerRef }: { mobileMenuTriggerRef?: RefObject<HTMLButtonElement> }) {
  const state = useSnapshot(appStore);
  const location = useLocation();
  const segment = location.pathname.split("/").filter(Boolean)[0] ?? "overview";
  const title = titles[segment] ?? "Overview";

  return <header className={styles.header}>
    <button ref={mobileMenuTriggerRef} className={styles.menu} type="button" aria-label="Open navigation" aria-controls="app-sidebar" aria-expanded={state.mobileMenuOpen} onClick={() => setMobileMenu(true)}>☰</button>
    <h1>{title}</h1>
    <div className={styles.actions}>
      <label><span>Theme</span><select aria-label="Color theme" value={state.theme} onChange={(event) => setTheme(event.target.value as ThemePreference)}>
        <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
      </select></label>
    </div>
  </header>;
}
