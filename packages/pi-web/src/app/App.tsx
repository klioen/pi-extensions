import { useMemo } from "react";
import { RouterProvider, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChatPage } from "../chat/ChatPage";
import DiskUsagePage from "../pages/DiskUsagePage";
import ExtensionsPage from "../pages/ExtensionsPage";
import MemoryPage from "../pages/MemoryPage";
import OverviewPage from "../pages/OverviewPage";
import SessionsPage from "../pages/SessionsPage";
import SkillsPage from "../pages/SkillsPage";
import { createAppRouter, type RouteComponentRegistry } from "./router";

function SessionsRoute() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const project = searchParams.get("project") ?? "";
  const projectSearch = (projectId: string) => projectId ? `?${new URLSearchParams({ project: projectId })}` : "";
  return <SessionsPage
    initialSessionId={id}
    initialProject={project}
    onSessionChange={(sessionId, projectId) => navigate({ pathname: sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : "/sessions", search: projectSearch(projectId) })}
  />;
}

function SkillsRoute() {
  const { id = "" } = useParams();
  return <SkillsPage initialSkillId={id} />;
}

export const defaultRoutes: RouteComponentRegistry = {
  overview: OverviewPage,
  chat: ChatPage,
  sessions: SessionsRoute,
  skills: SkillsRoute,
  extensions: ExtensionsPage,
  disk: DiskUsagePage,
  memory: MemoryPage,
};

export interface AppProps {
  routes?: RouteComponentRegistry;
}

export default function App({ routes = defaultRoutes }: AppProps) {
  const router = useMemo(() => createAppRouter(routes), [routes]);
  return <RouterProvider router={router} />;
}
