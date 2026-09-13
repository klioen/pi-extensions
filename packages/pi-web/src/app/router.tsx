import type { ComponentType, ReactNode } from "react";
import { Navigate, Outlet, createHashRouter } from "react-router-dom";
import { AppShell } from "../layout/AppShell";
import { EmptyState } from "../components/EmptyState";

export type RouteComponent = ComponentType;

export interface RouteComponentRegistry {
  overview?: RouteComponent;
  chat?: RouteComponent;
  sessions?: RouteComponent;
  skills?: RouteComponent;
  extensions?: RouteComponent;
  disk?: RouteComponent;
  memory?: RouteComponent;
}

const routeTitles: Record<keyof RouteComponentRegistry, string> = {
  overview: "Overview",
  chat: "Chat",
  sessions: "Sessions",
  skills: "Skills",
  extensions: "Extensions",
  disk: "Disk Usage",
  memory: "Memory",
};

function Placeholder({ title }: { title: string }) {
  return <EmptyState title={`${title} is being migrated`} description="This route is ready for its React page component." />;
}

function component(registry: RouteComponentRegistry, key: keyof RouteComponentRegistry): ReactNode {
  const Component = registry[key];
  return Component ? <Component /> : <Placeholder title={routeTitles[key]} />;
}

function ShellRoute() {
  return <AppShell><Outlet /></AppShell>;
}

export function createAppRouter(registry: RouteComponentRegistry = {}) {
  return createHashRouter([
    {
      element: <ShellRoute />,
      children: [
        { index: true, element: <Navigate to="/overview" replace /> },
        { path: "overview", element: component(registry, "overview") },
        { path: "chat", element: component(registry, "chat") },
        { path: "sessions/:id?", element: component(registry, "sessions") },
        { path: "skills/:id?", element: component(registry, "skills") },
        { path: "extensions", element: component(registry, "extensions") },
        { path: "disk/*", element: component(registry, "disk") },
        { path: "memory/*", element: component(registry, "memory") },
        { path: "*", element: <Navigate to="/overview" replace /> },
      ],
    },
  ]);
}
