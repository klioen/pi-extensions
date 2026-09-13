import { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSnapshot } from "valtio";
import { getProjects } from "../api/resources";
import { appStore, setMobileMenu, setProjects, toggleSidebar } from "../app/store";
import styles from "./Sidebar.module.less";

const navigation = [
  ["overview", "Overview", "◫"], ["chat", "Chat", "✦"], ["sessions", "Sessions", "⌁"],
  ["skills", "Skills", "◇"], ["extensions", "Extensions", "⬡"], ["disk", "Disk Usage", "▤"], ["memory", "Memory", "◎"],
] as const;

export function Sidebar() {
  const state = useSnapshot(appStore);
  const location = useLocation();
  const selectedProject = location.pathname.startsWith("/sessions") ? new URLSearchParams(location.search).get("project") ?? "" : undefined;

  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      appStore.projectsLoading = true;
      void getProjects().then((projects) => {
        if (active && current === generation) setProjects(projects);
      }).catch(() => {
        if (active && current === generation) appStore.projectsError = "Unavailable";
      }).finally(() => {
        if (active && current === generation) appStore.projectsLoading = false;
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pi-web:sessions-changed", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      generation += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pi-web:sessions-changed", refresh);
    };
  }, []);

  return <>
    <aside id="app-sidebar" className={`${styles.sidebar} ${state.sidebarCollapsed ? styles.collapsed : ""} ${state.mobileMenuOpen ? styles.open : ""}`} aria-label="Main navigation">
      <div className={styles.brand}><span className={styles.mark} aria-hidden="true">π</span><span className={styles.brandCopy}><strong role="heading" aria-level={2}>Pi Web</strong><small>Local workspace</small></span><button type="button" onClick={toggleSidebar} aria-label={state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={state.sidebarCollapsed}>{state.sidebarCollapsed ? "›" : "‹"}</button></div>
      <nav className={styles.nav} aria-label="Workspace">
        {navigation.map(([path, label, icon]) => <NavLink key={path} to={`/${path}`} title={label} onClick={() => setMobileMenu(false)} className={({ isActive }) => isActive ? styles.active : undefined}><span aria-hidden="true">{icon}</span><span className={styles.label}>{label}</span></NavLink>)}
      </nav>
      <section className={styles.projects} aria-labelledby="projects-title">
        <h2 id="projects-title">Projects</h2>
        <div className={styles.projectList}>
          {state.projectsLoading && <span className={styles.placeholder}>Loading…</span>}
          {!state.projectsLoading && state.projectsError && <span className={styles.placeholder}>{state.projectsError}</span>}
          {!state.projectsLoading && !state.projectsError && !state.projects.length && <span className={styles.placeholder}>No projects</span>}
          {state.projects.map((project) => {
            const parent = project.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/") || "No working directory";
            return <NavLink key={project.key} to={`/sessions?project=${encodeURIComponent(project.key)}`} title={project.cwd || project.label} onClick={() => setMobileMenu(false)} className={selectedProject === project.key ? styles.activeProject : undefined}><span aria-hidden="true">◇</span><span className={styles.projectCopy}><strong>{project.label}</strong><small>{parent}</small></span></NavLink>;
          })}
        </div>
      </section>
      <footer className={styles.footer}><span className={`${styles.dot} ${styles[state.connection]}`} aria-hidden="true" /><span className={styles.label}>{state.connection === "online" ? "Local service online" : state.connection === "offline" ? "Service unavailable" : "Connecting"}</span></footer>
    </aside>
    {state.mobileMenuOpen && <button className={styles.scrim} type="button" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
  </>;
}
