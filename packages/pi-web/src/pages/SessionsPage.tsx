import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectKey } from "../api/resources";
import type { ApiRequest } from "./shared/request";
import { ApiError, requestJson } from "./shared/request";
import ConversationFlow, { type ConversationMessage } from "../chat/ConversationFlow";
import { historyMessages } from "../chat/reducer";
import type { ChatHistoryEntry } from "../chat/types";
import { Badge, EmptyState, ErrorState, LoadingState } from "./shared/view";
import styles from "./SessionsPage.module.less";

type Session = { id: string; name?: string; firstMessage?: string; cwd?: string; projectId?: string; messageCount?: number; modified?: string | number; current?: boolean };
type SessionList = { sessions: Session[]; tree?: unknown[] };
type RecordValue = Record<string, unknown>;
type SessionDetail = { session: Session; current?: boolean; revision?: string; sourceTruncated?: boolean; summary?: RecordValue; diagnostics?: unknown[]; chatHistory?: ChatHistoryEntry[] };
type TranscriptItem = ConversationMessage & { role: "user" | "assistant" | "tool" };

export function normalizeTranscript(detail: SessionDetail): TranscriptItem[] {
  return historyMessages(detail.chatHistory ?? []) as TranscriptItem[];
}

function FlatSessionList({ sessions, selected, onSelect, onRename, onDelete }: { sessions: Session[]; selected: string; onSelect: (id: string) => void; onRename: (session: Session) => void; onDelete: (session: Session) => void }) {
  return <div className={styles.sessions}>{sessions.map((session) => <div className={`${styles.leaf} ${selected === session.id ? styles.selected : ""}`} key={session.id}><button type="button" onClick={() => onSelect(session.id)} aria-current={selected === session.id ? "true" : undefined}><strong>{session.name ?? session.firstMessage ?? "Untitled"}</strong><code>{session.id}</code><small>{session.messageCount ?? "—"} messages</small></button><details className={styles.menu}><summary aria-label={`Actions for ${session.name ?? session.id}`}>•••</summary><div><button type="button" onClick={() => onRename(session)}>Rename</button><button type="button" disabled={session.current} title={session.current ? "The current session cannot be deleted" : undefined} onClick={() => onDelete(session)}>Delete</button></div></details></div>)}</div>;
}

function Transcript({ items, sessionId }: { items: TranscriptItem[]; sessionId: string }) {
  if (!items.length) return <EmptyState>This session has no displayable conversation.</EmptyState>;
  return <ConversationFlow messages={items} className={styles.transcript} scopeKey={sessionId} />;
}

export default function SessionsPage({ request = requestJson, initialSessionId = "", initialProject = "", onSessionChange }: { request?: ApiRequest; initialSessionId?: string; initialProject?: string; onSessionChange?: (id: string, projectId: string) => void }) {
  const [data, setData] = useState<SessionList>(); const [catalog, setCatalog] = useState<Session[]>([]); const [selected, setSelected] = useState(initialSessionId); const [project, setProject] = useState(initialProject);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const projectRef = useRef(project); projectRef.current = project;
  const previousInitialSessionId = useRef(initialSessionId); const previousInitialProject = useRef(initialProject); const listGeneration = useRef(0); const detailGeneration = useRef(0); const navigationGeneration = useRef(0); const mutationControllers = useRef(new Map<string, AbortController>()); const [detailRequest, setDetailRequest] = useState(0);
  const [detail, setDetail] = useState<SessionDetail>(); const [error, setError] = useState<unknown>(); const [detailError, setDetailError] = useState<unknown>(); const [notice, setNotice] = useState("");
  const invalidateMutations = useCallback(() => { navigationGeneration.current += 1; for (const controller of mutationControllers.current.values()) controller.abort(); mutationControllers.current.clear(); }, []);
  const load = useCallback(() => { const generation = ++listGeneration.current; setError(undefined); return request<SessionList>("/api/sessions").then((next) => { if (listGeneration.current !== generation) return; const sessions = Array.isArray(next?.sessions) ? next.sessions : []; setData({ sessions }); setCatalog(sessions); setError(undefined); }, (reason) => { if (listGeneration.current === generation) setError(reason); }); }, [request]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { void load(); return () => { listGeneration.current += 1; }; }, [load]);
  useEffect(() => { if (previousInitialSessionId.current === initialSessionId) return; previousInitialSessionId.current = initialSessionId; invalidateMutations(); selectedRef.current = initialSessionId; setSelected(initialSessionId); }, [initialSessionId, invalidateMutations]);
  useEffect(() => { if (previousInitialProject.current === initialProject) return; previousInitialProject.current = initialProject; invalidateMutations(); projectRef.current = initialProject; setProject(initialProject); }, [initialProject, invalidateMutations]);
  useEffect(() => { if (!initialSessionId || !catalog.length) return; const session = catalog.find((item) => item.id === initialSessionId); if (!session) return; const canonicalProject = projectKey(session); if (project !== canonicalProject) { projectRef.current = canonicalProject; setProject(canonicalProject); } if (initialProject !== canonicalProject) onSessionChange?.(initialSessionId, canonicalProject); }, [catalog, initialProject, initialSessionId, onSessionChange, project]);
  useEffect(() => { const generation = ++detailGeneration.current; if (!selected) { setDetail(undefined); setDetailError(undefined); return; } const sessionId = selected; const controller = new AbortController(); setDetail(undefined); setDetailError(undefined); request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal }).then((next) => { if (detailGeneration.current === generation && selectedRef.current === sessionId) setDetail(next); }, (reason) => { if (detailGeneration.current === generation && selectedRef.current === sessionId && !(reason instanceof DOMException && reason.name === "AbortError")) setDetailError(reason); }); return () => { detailGeneration.current += 1; controller.abort(); }; }, [detailRequest, request, selected]);
  useEffect(() => () => invalidateMutations(), [invalidateMutations]);
  const visibleSessions = useMemo(() => (data?.sessions ?? []).filter((session) => projectKey(session) === project), [data, project]);
  const selectedSession = useMemo(() => catalog.find((session) => session.id === selected), [catalog, selected]);
  const selectSession = (session: Session) => { invalidateMutations(); selectedRef.current = session.id; setSelected(session.id); onSessionChange?.(session.id, projectKey(session)); };
  const mutate = async (session: Session, kind: "rename" | "delete") => { const key = `${kind}:${session.id}`; if (mutationControllers.current.has(key)) return; const controller = new AbortController(); const navigation = navigationGeneration.current; mutationControllers.current.set(key, controller); try { const latest = await request<SessionDetail>(`/api/sessions/${encodeURIComponent(session.id)}`, { signal: controller.signal }); if (navigationGeneration.current !== navigation) return; if (!latest.revision) throw new Error("This session is truncated and cannot be changed."); if (kind === "rename") { const name = window.prompt("Session name", session.name ?? "")?.trim(); if (!name || navigationGeneration.current !== navigation) return; await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", body: { name, revision: latest.revision }, signal: controller.signal }); if (selectedRef.current === session.id) setDetail((current) => current?.session.id === session.id ? { ...current, session: { ...current.session, name } } : current); setNotice("Session renamed."); } else { if (!window.confirm(`Delete session “${session.id}”? It will be moved to trash when available; otherwise it is permanently deleted.`) || navigationGeneration.current !== navigation) return; await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE", body: { revision: latest.revision }, signal: controller.signal }); if (selectedRef.current === session.id) { selectedRef.current = ""; setSelected(""); setDetail(undefined); onSessionChange?.("", projectRef.current); } setNotice("Session deleted."); } window.dispatchEvent(new Event("pi-web:sessions-changed")); await loadRef.current(); } finally { if (mutationControllers.current.get(key) === controller) mutationControllers.current.delete(key); } };
  const runMutation = (session: Session, kind: "rename" | "delete") => void mutate(session, kind).catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setNotice(reason instanceof ApiError && reason.status === 409 ? `Revision conflict: ${reason.message}` : reason instanceof Error ? reason.message : String(reason)); });
  if (error) return <ErrorState error={error} retry={load} />;
  if (!data) return <LoadingState />;
  return <main className={styles.page}>{notice && <div className={styles.notice} role="status">{notice}</div>}
    {!catalog.length && !project ? <EmptyState>No session projects found.</EmptyState> : <section className={styles.workbench}><aside className={styles.browser}>{visibleSessions.length ? <FlatSessionList sessions={visibleSessions} selected={selected} onSelect={(id) => { const session = visibleSessions.find((item) => item.id === id); if (session) selectSession(session); }} onRename={(session) => runMutation(session, "rename")} onDelete={(session) => runMutation(session, "delete")} /> : <EmptyState>No sessions found for this project.</EmptyState>}</aside>
      <article className={styles.detail}>{!selected ? <EmptyState>Select a session to inspect its conversation.</EmptyState> : detailError ? <ErrorState error={detailError} retry={() => setDetailRequest((value) => value + 1)} /> : !detail ? <LoadingState label="Loading session…" /> : <><header><div><h2>{detail.session.name ?? detail.session.firstMessage ?? detail.session.id}</h2><code>{detail.session.id}</code></div><Badge tone={detail.sourceTruncated ? "warn" : "good"}>{detail.sourceTruncated ? "truncated" : "bounded"}</Badge></header><Transcript items={normalizeTranscript(detail)} sessionId={detail.session.id} /></>}</article>
    </section>}{selectedSession?.current && <p className={styles.current}>This is the current running session. It can be renamed but not deleted.</p>}</main>;
}
