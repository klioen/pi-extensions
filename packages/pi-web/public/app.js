(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const view = $("#view");
  const title = $("#page-title");
  const connectionDot = $("#connection-dot");
  const connectionStatus = $("#connection-status");
  const routes = new Set(["overview", "sessions", "skills", "extensions", "disk", "memory"]);
  const state = {
    route: "overview",
    routeId: "",
    memoryPage: "overview",
    memoryId: "",
    diskPath: "",
    diskSort: "size",
    diskOrder: "desc",
    diskRefresh: false,
    sessionsQuery: "",
    selectedSessionId: "",
    selectedSessionRevision: "",
    request: null,
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function pick(object, keys, fallback = undefined) {
    if (!object || typeof object !== "object") return fallback;
    for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
    return fallback;
  }

  function list(value, keys = []) {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    return [];
  }

  function count(value, keys = []) {
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value.length;
    if (typeof value?.count === "number") return value.count;
    for (const key of keys) {
      const candidate = value?.[key];
      if (typeof candidate === "number") return candidate;
      if (Array.isArray(candidate)) return candidate.length;
      if (candidate && typeof candidate.count === "number") return candidate.count;
    }
    return 0;
  }

  function fmtDate(value) {
    if (!value) return "—";
    const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function stringify(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response;
    try {
      response = await fetch(path, { ...options, headers, signal: options.signal || state.request?.signal, credentials: "same-origin" });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      setConnection(false);
      throw new Error("无法连接 Pi Web 服务。");
    }
    setConnection(true);
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("json") ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      const message = typeof payload === "string" ? payload : pick(payload, ["error", "message"], `HTTP ${response.status}`);
      const error = new Error(message || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "data")) {
      const data = payload.data;
      if (Array.isArray(data)) return { items: data, meta: payload.meta || {} };
      if (data && typeof data === "object") return { ...data, meta: payload.meta || data.meta || {} };
      return { value: data, meta: payload.meta || {} };
    }
    return payload;
  }

  function setConnection(online) {
    connectionDot.className = `status-dot ${online ? "online" : "offline"}`;
    connectionStatus.textContent = online ? "Local service online" : "Service unavailable";
  }

  function loading() {
    view.setAttribute("aria-busy", "true");
    view.innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span><span>Loading local data…</span></div>';
  }

  function showError(error) {
    if (error?.name === "AbortError") return;
    view.setAttribute("aria-busy", "false");
    view.innerHTML = `<div class="error-state"><strong>REQUEST FAILED</strong><span>${esc(error?.message || error)}</span><button class="button" type="button" data-action="retry">Retry</button></div>`;
  }

  function empty(message) {
    return `<div class="empty"><strong>NO DATA</strong><span>${esc(message)}</span></div>`;
  }

  function toast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.textContent = message;
    $("#toast-region").append(node);
    setTimeout(() => node.remove(), 4200);
  }

  function viewHeader(heading, description, actions = "") {
    return `<header class="view-header"><div><h2>${esc(heading)}</h2><p>${esc(description)}</p></div>${actions ? `<div class="actions">${actions}</div>` : ""}</header>`;
  }

  function badge(text, tone = "") {
    return `<span class="badge ${tone}">${esc(text || "unknown")}</span>`;
  }

  function metric(label, value, note = "") {
    return `<article class="card metric"><div class="metric-label">${esc(label)}</div><div class="metric-value metric-accent">${esc(value)}</div><div class="metric-note">${esc(note)}</div></article>`;
  }

  function parseRoute() {
    const clean = location.hash.replace(/^#\/?/, "").split(/[?&]/)[0];
    const [candidate, ...idParts] = clean.split("/").filter(Boolean).map(decodeURIComponent);
    state.route = routes.has(candidate) ? candidate : "overview";
    state.routeId = idParts.join("/");
    state.diskPath = state.route === "disk" ? idParts.join("/") : "";
    if (state.route === "memory") {
      const pages = new Set(["overview", "jobs", "sessions", "rollouts", "phase2", "logs"]);
      if (idParts[0] === "artifact" && idParts[1]) {
        state.memoryPage = "artifact-detail";
        state.memoryId = idParts.slice(1).join("/");
        return;
      }
      state.memoryPage = pages.has(idParts[0]) ? idParts[0] : "overview";
      state.memoryId = idParts.slice(1).join("/");
    }
  }

  async function render() {
    state.request?.abort();
    state.request = new AbortController();
    parseRoute();
    title.textContent = state.route === "memory" ? `Memory / ${state.memoryPage}` : state.route[0].toUpperCase() + state.route.slice(1);
    $$('[data-route]').forEach((link) => {
      const active = link.dataset.route === state.route;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    closeMenu();
    loading();
    try {
      if (state.route === "overview") await renderOverview();
      else if (state.route === "sessions") {
        if (state.routeId) state.selectedSessionId = state.routeId;
        await renderSessions();
      }
      else if (state.route === "skills") await (state.routeId ? renderSkill(state.routeId) : renderSkills());
      else if (state.route === "extensions") await renderExtensions();
      else if (state.route === "disk") await renderDiskUsage();
      else if (state.route === "memory") await renderMemoryRoute();
      view.setAttribute("aria-busy", "false");
    } catch (error) { showError(error); }
  }

  async function renderOverview() {
    const data = await api("/api/overview");
    const recent = list(data, ["recentSessions", "sessions"]);
    const sessionCount = data.counts?.sessions ?? count(pick(data, ["sessionCount", "sessions"], 0), ["items"]);
    const skillCount = data.counts?.skills ?? count(pick(data, ["skillCount", "skills"], 0), ["items"]);
    const extensionCount = (data.counts?.extensions ?? 0) + (data.counts?.packages ?? 0) || count(pick(data, ["extensionCount", "extensions", "packages"], 0), ["items"]);
    const memoryCount = data.memory ? Object.values(data.memory).filter(Boolean).length : count(pick(data, ["memoryCount", "memory"], 0), ["documents", "items"]);
    view.innerHTML = `${viewHeader("System overview", "A readout of this Pi installation and its local assets.")}
      <section class="grid metric-grid" aria-label="Overview metrics">
        ${metric("Sessions", sessionCount, "indexed conversations")}
        ${metric("Skills", skillCount, "available capabilities")}
        ${metric("Extensions", extensionCount, "extensions and packages")}
        ${metric("Memory", memoryCount, "documents and logs")}
      </section>
      <section class="grid two-column" style="margin-top:16px">
        <article class="card"><div class="card-header"><h2>Recent sessions</h2><a class="row-link" href="#/sessions">View all →</a></div>
          ${recent.length ? `<div class="stack">${recent.slice(0, 6).map(sessionItem).join("")}</div>` : empty("No recent sessions were returned.")}
        </article>
        <article class="card"><div class="card-header"><h2>Runtime</h2>${badge("loopback", "good")}</div>${definitionList(runtimeFacts(data))}</article>
      </section>`;
  }

  function runtimeFacts(data) {
    const runtime = pick(data, ["runtime", "server", "status"], {});
    const facts = {
      Host: pick(runtime, ["host"], pick(data, ["host"], location.hostname)),
      Port: pick(runtime, ["port"], pick(data, ["port"], location.port || "default")),
      Version: pick(runtime, ["version"], pick(data, ["version"], "V1")),
      Project: pick(runtime, ["cwd", "project", "projectPath"], pick(data, ["cwd", "project"], "—")),
    };
    return facts;
  }

  function definitionList(facts) {
    return `<dl class="definition-list">${Object.entries(facts).map(([key, value]) => `<dt>${esc(key)}</dt><dd class="path">${esc(stringify(value))}</dd>`).join("")}</dl>`;
  }

  function sessionItem(item) {
    const id = pick(item, ["id", "sessionId", "session_id"], "");
    const label = pick(item, ["title", "name", "firstMessage", "id"], "Untitled session");
    const date = pick(item, ["updatedAt", "modifiedAt", "modified", "mtime", "createdAt", "timestamp"]);
    return `<div class="list-item"><div class="item-top"><div><a class="row-link" href="#/sessions/${encodeURIComponent(id)}">${esc(label)}</a><div class="path">${esc(id)}</div></div>${badge(pick(item, ["status", "provider", "model"], "session"), "info")}</div><div class="timestamp">${esc(fmtDate(date))}</div></div>`;
  }

  function sessionTreeLeaf(item) {
    const id = pick(item, ["id", "sessionId", "session_id"], "");
    const label = pick(item, ["title", "name", "firstMessage", "id"], "Untitled");
    const messages = pick(item, ["messageCount", "entryCount", "entries"], "—");
    const selected = id === state.selectedSessionId;
    return `<li class="session-tree-leaf${selected ? " selected" : ""}"><button class="session-tree-select" type="button" data-action="select-session" data-id="${esc(id)}"${selected ? ' aria-current="true"' : ""}><span class="session-tree-file" aria-hidden="true">◇</span><span class="session-tree-primary"><strong>${esc(label)}</strong><span class="path">${esc(id)}</span></span><span class="session-tree-messages">${esc(messages)} messages</span></button><details class="session-actions"><summary aria-label="更多操作" title="更多操作">•••</summary><div class="session-actions-menu"><button type="button" data-action="rename-session" data-id="${esc(id)}" data-name="${esc(item.name || "")}">重命名</button><button class="danger" type="button" data-action="delete-session" data-id="${esc(id)}"${item.current ? " disabled title=\"当前运行中的 session 不能删除\"" : ""}>删除</button></div></details></li>`;
  }

  function sessionTreeNode(node, depth = 0) {
    const children = list(node, ["children"]);
    const sessions = list(node, ["sessions"]);
    const contents = `${children.map((child) => sessionTreeNode(child, depth + 1)).join("")}${sessions.length ? `<ul class="session-tree-sessions">${sessions.map(sessionTreeLeaf).join("")}</ul>` : ""}`;
    const defaultOpen = children.length > 0;
    return `<details class="session-tree-directory" data-depth="${depth}"${defaultOpen ? " open" : ""}><summary><span class="session-tree-chevron" aria-hidden="true">›</span><span class="session-tree-folder" aria-hidden="true">▱</span><strong>${esc(node.name || "Unknown project")}</strong>${badge(`${Number(node.sessionCount) || 0} sessions`, "info")}<time class="timestamp">${esc(fmtDate(node.modified))}</time></summary><div class="session-tree-children">${contents}</div></details>`;
  }

  async function renderSessions() {
    const query = state.sessionsQuery;
    const data = await api(`/api/sessions${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    const items = list(data, ["sessions", "items", "results"]);
    const tree = list(data, ["tree"]);
    if (state.selectedSessionId && !items.some((item) => pick(item, ["id", "sessionId", "session_id"]) === state.selectedSessionId)) state.selectedSessionId = "";
    view.innerHTML = `${viewHeader("Sessions", "Browse session history by working directory and inspect JSONL details in place.", `<form class="search-form" id="session-search" role="search"><input type="search" name="q" value="${esc(query)}" placeholder="Search sessions" aria-label="Search sessions"><button class="button primary" type="submit">Search</button></form>`)}
      <section class="sessions-workbench"><aside class="session-browser">${items.length ? `<div class="session-tree" aria-label="Session directories">${tree.map((node) => sessionTreeNode(node)).join("")}</div>` : empty(query ? "No sessions match this query." : "No sessions found.")}</aside><article class="session-detail" id="session-detail">${state.selectedSessionId ? '<div class="loading"><span class="spinner" aria-hidden="true"></span><span>Loading session JSONL…</span></div>' : empty("Select a session to inspect its JSONL details.")}</article></section>`;
    if (state.selectedSessionId) await loadSessionDetail(state.selectedSessionId);
  }

  function renderSessionDetail(data, id) {
    const headerRecord = pick(data, ["header", "session", "metadata"], {});
    const header = pick(headerRecord, ["payload"], headerRecord);
    const entries = list(data, ["entries", "messages", "items"]);
    const stats = pick(data, ["stats", "statistics", "summary"], {});
    state.selectedSessionRevision = data.revision || "";
    return `<div class="session-detail-header"><div><p class="eyebrow">JSONL DETAIL</p><h2>${esc(pick(data.session, ["name", "firstMessage", "id"], "Session detail"))}</h2><div class="path">${esc(id)}</div></div>${data.sourceTruncated ? badge("truncated", "warn") : badge("bounded", "good")}</div><div class="session-detail-scroll"><section class="stack"><article class="card"><div class="card-header"><h3>Header</h3></div>${definitionList(flatFacts(header))}</article><article class="card"><div class="card-header"><h3>Statistics</h3></div>${definitionList(flatFacts(stats))}</article><article class="card"><div class="card-header"><h3>Entries</h3>${badge(`${entries.length} records`, "info")}</div>${entries.length ? `<div class="entries">${entries.map(entryItem).join("")}</div>` : empty("This session has no displayable entries.")}</article></section></div>`;
  }

  async function loadSessionDetail(id) {
    state.selectedSessionId = id;
    $$(".session-tree-leaf").forEach((node) => node.classList.toggle("selected", node.querySelector('[data-action="select-session"]')?.dataset.id === id));
    const panel = $("#session-detail");
    if (!panel) return;
    panel.innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span><span>Loading session JSONL…</span></div>';
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (state.selectedSessionId === id) panel.innerHTML = renderSessionDetail(data, id);
    } catch (error) {
      panel.innerHTML = `<div class="error-state"><strong>REQUEST FAILED</strong><span>${esc(error.message)}</span></div>`;
    }
  }

  function flatFacts(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return { Value: object ?? "—" };
    const entries = Object.entries(object).slice(0, 30).map(([key, value]) => [key, typeof value === "object" ? stringify(value) : value]);
    return Object.fromEntries(entries.length ? entries : [["Status", "No metadata"]]);
  }

  function entryItem(entry) {
    const role = pick(entry, ["role", "type", "kind"], "entry");
    const content = pick(entry, ["content", "text", "message", "data"], entry);
    const body = Array.isArray(content) ? content.map((part) => pick(part, ["text", "content"], stringify(part))).join("\n") : stringify(content);
    return `<article class="entry ${esc(role)}"><div class="entry-head"><strong>${esc(role)}</strong><span>${esc(fmtDate(pick(entry, ["timestamp", "createdAt", "time"])))}</span></div><div class="entry-body">${esc(body)}</div></article>`;
  }

  async function renderSkills() {
    const data = await api("/api/skills");
    const items = list(data, ["skills", "items", "results"]);
    view.innerHTML = `${viewHeader("Skills", "Inspect skill metadata and edit only resources authorized by the server.")}
      ${items.length ? `<div class="grid two-column">${items.map((item) => {
        const id = pick(item, ["id", "skillId", "name"], "");
        const editable = Boolean(pick(item, ["editable", "writable", "canEdit", "mutable"], false));
        const diagnostics = list(pick(item, ["diagnostics", "issues"], []));
        return `<article class="card"><div class="card-header"><h2><a class="row-link" href="#/skills/${encodeURIComponent(id)}">${esc(pick(item, ["name", "title"], id))}</a></h2>${badge(editable ? "editable" : "read only", editable ? "good" : "")}</div><p>${esc(pick(item, ["description"], "No description"))}</p><p class="path">${esc(pick(item, ["path", "file"], ""))}</p><div class="actions">${badge(pick(item, ["scope"], "unknown"), "info")}${badge(pick(item, ["origin"], "top-level"))}${badge(pick(item, ["source"], "unknown"))}${diagnostics.length ? badge(`${diagnostics.length} diagnostics`, "warn") : badge("healthy", "good")}</div></article>`;
      }).join("")}</div>` : empty("No skills found in the configured roots.")}`;
  }

  async function renderSkill(id) {
    const data = await api(`/api/skills/${encodeURIComponent(id)}`);
    const skill = pick(data, ["skill", "item"], data);
    const content = pick(data, ["content", "markdown", "source"], pick(skill, ["content", "markdown", "source"], ""));
    const revision = pick(skill, ["revision", "etag", "hash"], pick(data, ["revision", "etag", "hash"], ""));
    const editable = Boolean(pick(skill, ["editable", "writable", "canEdit", "mutable"], false));
    const diagnostics = list(pick(skill, ["diagnostics", "issues"], []));
    view.innerHTML = `${viewHeader(pick(skill, ["name", "title"], id), pick(skill, ["description"], "Skill detail"), '<a class="button secondary" href="#/skills">← Skills</a>')}
      <section class="grid two-column"><article class="card"><div class="card-header"><h2>SKILL.md</h2>${badge(editable ? "editable" : "read only", editable ? "good" : "")}</div>
        <textarea class="editor" id="resource-editor" ${editable ? "" : "readonly"} spellcheck="false" aria-label="Skill Markdown content">${esc(content)}</textarea>
        ${editable ? `<div class="actions" style="margin-top:14px"><button class="button primary" type="button" data-action="save-skill" data-id="${esc(id)}" data-revision="${esc(revision)}">Save revision</button><button class="button danger" type="button" data-action="delete-skill" data-id="${esc(id)}" data-revision="${esc(revision)}">Delete skill</button></div>` : ""}
      </article><aside class="stack"><article class="card"><div class="card-header"><h2>Resource</h2></div>${definitionList({ ID: id, Scope: pick(skill, ["scope"], "—"), Origin: pick(skill, ["origin"], "—"), Source: pick(skill, ["source"], "—"), Path: pick(skill, ["path", "file"], "—"), Revision: revision || "—" })}</article>
      <article class="card"><div class="card-header"><h2>Diagnostics</h2></div>${diagnostics.length ? `<div class="stack">${diagnostics.map((item) => `<div class="list-item">${esc(typeof item === "string" ? item : pick(item, ["message", "description"], stringify(item)))}</div>`).join("")}</div>` : '<p class="meta">No diagnostics reported.</p>'}</article></aside></section>`;
  }

  async function renderExtensions() {
    const data = await api("/api/extensions");
    const extensions = list(data, ["extensions", "items", "entries"]);
    const packages = list(data?.settings?.packages, ["items", "packages"]);
    view.innerHTML = `${viewHeader("Extensions", "Static inventory only. V1 never loads extension code or mutates packages.")}
      <section class="grid two-column"><article class="card"><div class="card-header"><h2>Extension entries</h2>${badge(`${extensions.length} found`, "info")}</div>${extensions.length ? `<div class="stack">${extensions.map(extensionItem).join("")}</div>` : empty("No extension entries found.")}</article>
      <article class="card"><div class="card-header"><h2>Packages</h2>${badge(`${packages.length} configured`, "info")}</div>${packages.length ? `<div class="stack">${packages.map(extensionItem).join("")}</div>` : empty("No packages returned.")}</article></section>`;
  }

  function extensionItem(item) {
    if (typeof item === "string") return `<div class="list-item"><h3>${esc(item)}</h3></div>`;
    const title = pick(item, ["displayName", "name", "relativePath", "source", "id", "package"], "Extension");
    const source = pick(item, ["source", "relativePath", "path", "entry", "sourcePath"], "");
    return `<div class="list-item"><div class="item-top"><div><h3>${esc(title)}</h3><p>${esc(pick(item, ["description", "version"], ""))}</p></div>${badge(pick(item, ["scope", "type"], "configured"), "info")}</div>${source ? `<div class="path">${esc(source)}</div>` : ""}</div>`;
  }

  function diskHash(path) {
    const segments = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return segments.length ? `#/disk/${segments.map(encodeURIComponent).join("/")}` : "#/disk";
  }

  function diskEntryType(item) {
    const type = String(pick(item, ["type", "kind"], "other")).toLowerCase();
    if (item?.isDirectory === true || item?.directory === true || /directory|folder|dir/.test(type)) return "directory";
    if (type === "symlink" || type === "link") return "symlink";
    if (type === "file") return "file";
    return "other";
  }

  function diskDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) return value ? String(value) : "—";
    if (duration < 1000) return `${Math.round(duration)} ms`;
    return `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)} s`;
  }

  function diskSortButton(key, label) {
    const active = state.diskSort === key;
    const arrow = active ? (state.diskOrder === "asc" ? " ↑" : " ↓") : "";
    return `<button class="disk-sort${active ? " active" : ""}" type="button" data-action="disk-sort" data-sort="${key}" aria-label="Sort by ${label}${active ? `, ${state.diskOrder === "asc" ? "ascending" : "descending"}` : ""}">${esc(label)}${arrow}</button>`;
  }

  function diskBreadcrumbs(path, supplied) {
    const provided = Array.isArray(supplied) ? supplied : [];
    if (provided.length) return `<nav class="disk-breadcrumbs" aria-label="Disk path">${provided.map((item, index) => `${index ? '<span aria-hidden="true">/</span>' : ""}<a href="${diskHash(pick(item, ["relativePath", "path"], ""))}"${index === provided.length - 1 ? ' aria-current="page"' : ""}>${esc(pick(item, ["name", "label"], index ? "Unnamed" : "/"))}</a>`).join("")}</nav>`;
    const segments = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const crumbs = [`<a href="#/disk"${segments.length ? "" : ' aria-current="page"'}>/</a>`];
    let current = "";
    segments.forEach((segment, index) => {
      current = current ? `${current}/${segment}` : segment;
      const active = index === segments.length - 1;
      crumbs.push(`<span aria-hidden="true">/</span><a href="${diskHash(current)}"${active ? ' aria-current="page"' : ""}>${esc(segment)}</a>`);
    });
    return `<nav class="disk-breadcrumbs" aria-label="Disk path">${crumbs.join("")}</nav>`;
  }

  function diskPercent(item, totalSize) {
    const supplied = Number(pick(item, ["percent", "percentage", "share"]));
    const calculated = totalSize > 0 ? Number(pick(item, ["size", "bytes"], 0)) / totalSize * 100 : 0;
    const percent = Math.max(0, Math.min(100, Number.isFinite(supplied) ? supplied : calculated));
    return `<div class="disk-percent"><span><i style="width:${percent.toFixed(2)}%"></i></span><small>${percent.toFixed(percent >= 10 ? 0 : 1)}%</small></div>`;
  }

  function diskDiagnostics(data) {
    const diagnostics = list(pick(data, ["diagnostics", "warnings", "errors"], pick(data?.scan, ["diagnostics", "warnings", "errors"], [])));
    if (!diagnostics.length) return "";
    return `<details class="disk-diagnostics"><summary>Diagnostics (${diagnostics.length})</summary><div>${diagnostics.map((item) => `<pre>${esc(typeof item === "string" ? item : stringify(item))}</pre>`).join("")}</div></details>`;
  }

  async function renderDiskUsage() {
    const query = new URLSearchParams({ sort: state.diskSort, order: state.diskOrder });
    if (state.diskPath) query.set("path", state.diskPath);
    if (state.diskRefresh) query.set("refresh", "1");
    state.diskRefresh = false;
    const data = await api(`/api/disk-usage?${query}`);
    const entries = list(data, ["entries", "items", "children"]);
    const current = pick(data, ["current"], {});
    const currentPath = String(pick(current, ["relativePath", "path"], pick(data, ["path", "currentPath", "current_path"], state.diskPath)));
    const totalSize = Number(pick(data, ["totalSize", "total_size", "size", "bytes"], 0));
    const fileCount = pick(data, ["fileCount", "file_count", "files"], entries.filter((item) => diskEntryType(item) === "file").length);
    const directoryCount = pick(data, ["directoryCount", "directory_count", "dirCount", "directories"], entries.filter((item) => diskEntryType(item) === "directory").length);
    const scan = pick(data, ["scan", "metadata", "meta"], {});
    const scannedAt = pick(data, ["scannedAt", "scanTime", "scan_time", "generatedAt"], pick(scan, ["scannedAt", "startedAt", "completedAt", "timestamp"]));
    const duration = pick(data, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"], pick(scan, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms", "duration"]));
    const partial = Boolean(pick(data, ["partial", "isPartial", "is_partial"], pick(scan, ["partial", "isPartial"], false)));
    const parent = pick(data, ["parent"], currentPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").slice(0, -1).join("/"));
    const atRoot = parent === null || !currentPath;
    const actions = `<a class="button secondary${atRoot ? " disabled" : ""}" href="${atRoot ? diskHash(currentPath) : diskHash(parent)}"${atRoot ? ' aria-disabled="true" tabindex="-1"' : ""}>← Parent</a><button class="button primary" type="button" data-action="disk-refresh">Refresh</button>`;
    const rows = entries.map((item) => {
      const type = diskEntryType(item);
      const name = pick(item, ["name", "basename", "label"], "Unnamed");
      const itemPath = pick(item, ["relativePath", "path", "fullPath", "full_path"], `${currentPath.replace(/[\\/]$/, "")}/${name}`);
      const canDrillDown = item?.canDrillDown === true && type === "directory";
      const marker = type === "symlink" ? "↗" : type === "other" ? "?" : "·";
      const displayName = canDrillDown ? `<a class="disk-entry-link" href="${diskHash(itemPath)}"><span aria-hidden="true">▸</span>${esc(name)}</a>` : `<span class="disk-file"><span aria-hidden="true">${marker}</span>${esc(name)}</span>`;
      return `<tr class="disk-row ${type}"><td>${displayName}</td><td>${badge(type, type === "directory" ? "info" : "")}</td><td class="disk-size">${esc(formatBytes(pick(item, ["size", "bytes"])))}</td><td>${diskPercent(item, totalSize)}</td><td class="timestamp">${esc(fmtDate(pick(item, ["modified", "modifiedAt", "mtime", "updatedAt"])))}</td></tr>`;
    }).join("");
    view.innerHTML = `${viewHeader("Disk Usage", "Inspect local disk consumption by directory.", actions)}
      ${diskBreadcrumbs(currentPath, data.breadcrumbs)}
      <div class="disk-current-path path" title="${esc(currentPath || "/")}">${esc(currentPath || "/")}</div>
      <section class="grid disk-metrics" aria-label="Disk scan summary">
        ${metric("Total size", formatBytes(totalSize), partial ? "partial result" : "scanned contents")}
        ${metric("Files", fileCount, "files in scan")}
        ${metric("Directories", directoryCount, "directories in scan")}
        ${metric("Scan", fmtDate(scannedAt), `${diskDuration(duration)}${partial ? " · partial" : " · complete"}`)}
      </section>
      ${partial ? '<div class="disk-partial" role="status">This scan is partial; totals may be incomplete.</div>' : ""}
      <section class="disk-table-section">
        ${entries.length ? `<div class="table-wrap"><table class="disk-table"><thead><tr><th>${diskSortButton("name", "Name")}</th><th>${diskSortButton("type", "Type")}</th><th>${diskSortButton("size", "Size")}</th><th>Share</th><th>${diskSortButton("modified", "Modified")}</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("This directory has no entries.")}
      </section>
      ${diskDiagnostics(data)}`;
  }

  const memoryPages = [
    ["overview", "Overview"], ["jobs", "Jobs"], ["sessions", "Indexed Sessions"],
    ["rollouts", "Rollout Memory"], ["phase2", "Phase 2"], ["logs", "Logs"],
  ];

  function memoryNav() {
    return `<nav class="memory-nav" aria-label="Memory Observatory">${memoryPages.map(([id, label]) => `<a href="#/memory/${id}" class="${state.memoryPage === id ? "active" : ""}"${state.memoryPage === id ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>`;
  }

  function memoryShell(heading, description, body, actions = "") {
    return `${viewHeader(heading, description, actions)}${memoryNav()}${body}`;
  }

  function statusTone(value) {
    const text = String(value || "").toLowerCase();
    if (/fail|error|dead|stale|missing|unavailable|blocked|expired|exhausted|mismatch/.test(text)) return "bad";
    if (/run|pending|queue|warn|partial|degrad|idle/.test(text)) return "warn";
    if (/ok|ready|success|complete|done|active|available|published|consistent/.test(text)) return "good";
    return "info";
  }

  function statusBadge(value) {
    return badge(value || "unknown", statusTone(value));
  }

  function itemValue(item, keys, fallback = "—") {
    const value = pick(item, keys, fallback);
    return value && typeof value === "object" ? stringify(value) : value;
  }

  function capabilityNotice(data, options = {}) {
    const availabilityValue = pick(data, ["availability", "status"], pick(data?.meta, ["availability", "status"], ""));
    const available = availabilityValue && typeof availabilityValue === "object" ? availabilityValue.available !== false : !/unavailable|error|failed/i.test(String(availabilityValue || "available"));
    const reason = availabilityValue && typeof availabilityValue === "object" ? availabilityValue.reason : "";
    const capabilityValue = pick(data, ["capabilities"], data?.meta?.capabilities) || {};
    const capabilities = capabilityValue.features && typeof capabilityValue.features === "object" ? capabilityValue.features : capabilityValue;
    const entries = Object.entries(capabilities).filter(([, value]) => typeof value === "boolean");
    const enabled = entries.filter(([, value]) => value).length;
    const missing = entries.filter(([, value]) => !value).map(([name]) => name);
    const diagnostics = list(pick(data, ["diagnostics", "warnings"], pick(data?.meta, ["diagnostics", "warnings"], [])));
    const healthy = available && missing.length === 0 && diagnostics.length === 0;
    if (!options.always && healthy) return "";
    if (!entries.length && !availabilityValue && !diagnostics.length) return "";
    const summary = `${available ? "Database connected" : "Database unavailable"} · ${enabled}/${entries.length} capabilities · ${healthy ? "Schema healthy" : "Attention required"}`;
    const details = [reason, missing.length ? `Missing capabilities: ${missing.join(", ")}` : "", ...diagnostics.map((note) => typeof note === "string" ? note : stringify(note))].filter(Boolean);
    return `<aside class="capability-notice ${healthy ? "healthy" : "degraded"}"><div>${statusBadge(healthy ? "healthy" : available ? "degraded" : "unavailable")}</div><div><strong>${esc(summary)}</strong>${details.length ? `<details><summary>View diagnostics</summary><div class="capability-details">${details.map((note) => `<div class="meta">${esc(note)}</div>`).join("")}</div></details>` : ""}</div></aside>`;
  }

  function simpleTable(items, columns, emptyMessage) {
    if (!items.length) return empty(emptyMessage);
    return `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${esc(column.label)}</th>`).join("")}</tr></thead><tbody>${items.map((item) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(item) : esc(itemValue(item, column.keys))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  async function renderMemoryRoute() {
    if (state.memoryPage === "overview") return renderMemoryOverview();
    if (state.memoryPage === "jobs") return renderMemoryJobs();
    if (state.memoryPage === "sessions") return renderMemorySessions();
    if (state.memoryPage === "rollouts") return state.memoryId ? renderRollout(state.memoryId) : renderRollouts();
    if (state.memoryPage === "phase2") return renderMemoryPhase2();
    if (state.memoryPage === "artifact-detail") return renderArtifact(state.memoryId);
    return renderMemoryLogs();
  }

  const overviewArtifactNames = ["memory_summary.md", "MEMORY.md", "raw_memories.md", "rollout_summaries", "skills"];

  function artifactIdOf(item) {
    return itemValue(item, ["artifactId", "artifact_id", "id"], "");
  }

  function artifactNameOf(item) {
    return itemValue(item, ["name", "title", "path", "id"], "Unnamed artifact");
  }

  function isArtifactDirectory(item) {
    return Array.isArray(item?.items) || /director|folder|collection/i.test(String(itemValue(item, ["kind", "type"], "")));
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let amount = bytes;
    let unit = "B";
    for (const candidate of units) {
      amount /= 1024;
      unit = candidate;
      if (amount < 1024) break;
    }
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
  }

  function artifactMeasure(item) {
    if (isArtifactDirectory(item)) {
      const itemCount = pick(item, ["itemCount", "entryCount", "count"], Array.isArray(item?.items) ? item.items.length : undefined);
      return itemCount === undefined ? "— entries" : `${itemCount} ${Number(itemCount) === 1 ? "entry" : "entries"}`;
    }
    return formatBytes(pick(item, ["size", "bytes", "contentLength", "content_length"]));
  }

  function artifactOverviewCard(item) {
    const id = artifactIdOf(item);
    const name = artifactNameOf(item);
    const heading = id ? `<a class="row-link" href="#/memory/artifact/${encodeURIComponent(id)}">${esc(name)}</a>` : esc(name);
    return `<article class="card artifact-overview-card"><div class="card-header"><h2>${heading}</h2>${statusBadge(itemValue(item, ["status", "consistency"], id ? "available" : "missing"))}</div><div class="artifact-kind">${esc(isArtifactDirectory(item) ? "Directory" : "File")}</div><dl class="artifact-card-meta"><div><dt>Updated</dt><dd>${esc(fmtDate(pick(item, ["modifiedAt", "updatedAt", "mtime", "updated_at"])))}</dd></div><div><dt>${isArtifactDirectory(item) ? "Contents" : "Size"}</dt><dd>${esc(artifactMeasure(item))}</dd></div></dl>${id ? `<a class="artifact-open" href="#/memory/artifact/${encodeURIComponent(id)}" aria-label="Open ${esc(name)}">View details →</a>` : '<span class="artifact-open unavailable">Not available</span>'}</article>`;
  }

  async function renderMemoryOverview() {
    const [overview, workers, artifactsData] = await Promise.all([
      api("/api/memory/observatory/overview"),
      api("/api/memory/observatory/workers"),
      api("/api/memory/observatory/artifacts"),
    ]);
    const artifacts = list(artifactsData, ["items", "artifacts"]);
    const byName = new Map(artifacts.map((item) => [String(artifactNameOf(item)).replace(/\/$/, ""), item]));
    const overviewArtifacts = overviewArtifactNames.map((name) => byName.get(name) || { name, type: ["rollout_summaries", "skills"].includes(name) ? "directory" : "file", status: "missing" });
    const stages = list(overview, ["pipeline", "stages", "items"]);
    const workerItems = list(workers, ["items", "workers", "leases"]);
    const defaultStages = ["Session scan", "Phase 1 extraction", "Phase 2 consolidation", "Artifact publication"].map((name) => ({ name, status: "unknown", updatedAt: null }));
    const pipeline = (stages.length ? stages : defaultStages).map((stage, index, all) => {
      const updatedAt = pick(stage, ["updatedAt", "updated_at", "timestamp", "time"]);
      const detail = pick(stage, ["description", "detail"]);
      const timeLabel = updatedAt ? fmtDate(updatedAt) : "No activity recorded";
      return `<article class="pipeline-stage"><div class="stage-index">${index + 1}</div><div><strong>${esc(itemValue(stage, ["name", "stage", "label"], `Stage ${index + 1}`))}</strong><div class="meta">${esc(detail ? `${detail} · ${timeLabel}` : timeLabel)}</div></div>${statusBadge(itemValue(stage, ["status", "state"], "unknown"))}${index < all.length - 1 ? '<span class="pipeline-arrow" aria-hidden="true">→</span>' : ""}</article>`;
    }).join("");
    const workerTable = simpleTable(workerItems, [
      { label: "Worker", render: (item) => `<strong>${esc(itemValue(item, ["ownerId", "workerId", "worker_id", "leaseKey", "id", "name"]))}</strong>` },
      { label: "Status", render: (item) => statusBadge(itemValue(item, ["status", "state"], "unknown")) },
      { label: "Heartbeat", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["heartbeatAt", "heartbeat_at", "updatedAt"])))}</span>` },
      { label: "Lease expires", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["leaseUntil", "expiresAt", "leaseExpiresAt", "lease_expires_at"])))}</span>` },
    ], "No worker leases returned.");
    view.innerHTML = memoryShell("Memory Overview", "Memory database health, processing pipeline, workers, and published artifacts.", `${capabilityNotice(overview, { always: true })}
      <section class="observatory-section"><div class="card-header"><h2>Pipeline</h2>${statusBadge(itemValue(overview, ["pipelineStatus", "status"], "unknown"))}</div><div class="pipeline" aria-label="Memory pipeline">${pipeline}</div></section>
      <section class="observatory-section"><div class="card-header"><h2>Worker leases</h2>${badge(`${workerItems.length} workers`, "info")}</div>${workerTable}</section>
      <section class="observatory-section"><div class="card-header"><h2>Memory files and directories</h2>${badge(`${overviewArtifacts.length} resources`, "info")}</div><div class="artifact-overview-grid" aria-label="Memory files and directories">${overviewArtifacts.map(artifactOverviewCard).join("")}</div></section>`);
  }

  async function renderMemoryJobs() {
    const data = await api("/api/memory/observatory/jobs");
    const items = list(data, ["items", "jobs"]);
    view.innerHTML = memoryShell("Jobs", "Safe job fields only; payloads and ownership tokens are never displayed.", `${capabilityNotice(data)}${simpleTable(items, [
      { label: "Job", render: (item) => `<strong>${esc(itemValue(item, ["type", "kind", "jobType", "id"]))}</strong><div class="path">${esc(itemValue(item, ["jobKey", "id", "jobId", "job_id"], ""))}</div>` },
      { label: "Status", render: (item) => statusBadge(itemValue(item, ["state", "status"], "unknown")) },
      { label: "Retries left", keys: ["retryRemaining", "attempts", "attemptCount", "attempt_count"] },
      { label: "Created", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["createdAt", "created_at"])))}</span>` },
      { label: "Updated", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["updatedAt", "updated_at", "finishedAt"])))}</span>` },
      { label: "Error", render: (item) => `<span class="truncate" title="${esc(itemValue(item, ["error", "lastError", "last_error"], ""))}">${esc(itemValue(item, ["error", "lastError", "last_error"], "—"))}</span>` },
    ], "No jobs returned.")}`);
  }

  async function renderMemorySessions() {
    const data = await api("/api/memory/observatory/sessions");
    const items = list(data, ["items", "sessions"]);
    view.innerHTML = memoryShell("Indexed Sessions", "Sessions known to the memory index and their scan state.", `${capabilityNotice(data)}${simpleTable(items, [
      { label: "Session", render: (item) => `<strong>${esc(itemValue(item, ["title", "sessionId", "session_id", "id"]))}</strong><div class="path">${esc(itemValue(item, ["sessionId", "session_id", "id"], ""))}</div>` },
      { label: "Scan", render: (item) => statusBadge(itemValue(item, ["scanStatus", "scan_status", "status"], "unknown")) },
      { label: "Phase 1", render: (item) => statusBadge(itemValue(item, ["phase1Status", "phase1_status", "memoryStatus"], "unknown")) },
      { label: "Turns", keys: ["turnCount", "turn_count", "entries"] },
      { label: "Modified", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["modifiedAt", "modified_at", "updatedAt"])))}</span>` },
    ], "No indexed sessions returned.")}`);
  }

  async function renderRollouts() {
    const data = await api("/api/memory/observatory/phase1");
    const items = list(data, ["items", "phase1", "outputs"]);
    view.innerHTML = memoryShell("Rollout Memory", "Metadata only. Raw memory and rollout summaries load only after explicit confirmation.", `${capabilityNotice(data)}<div class="artifact-legend"><span><i class="legend-dot raw"></i>raw_memory: per-rollout extraction</span><span><i class="legend-dot summary"></i>rollout_summary: per-rollout summary</span><span><i class="legend-dot file"></i>rollout_summaries/*.md: materialized files</span><span><i class="legend-dot collection"></i>raw_memories.md: collection input</span></div>${simpleTable(items, [
      { label: "Session", render: (item) => { const id = itemValue(item, ["sessionId", "session_id", "id"], ""); return `<a class="row-link" href="#/memory/rollouts/${encodeURIComponent(id)}">${esc(itemValue(item, ["title", "sessionId", "session_id", "id"]))}</a><div class="path">${esc(id)}</div>`; } },
      { label: "Status", render: (item) => statusBadge(itemValue(item, ["status", "state"], "available")) },
      { label: "Raw bytes", keys: ["rawMemoryBytes", "rawMemoryLength", "raw_memory_length", "rawLength"] },
      { label: "Summary bytes", keys: ["rolloutSummaryBytes", "rolloutSummaryLength", "rollout_summary_length", "summaryLength"] },
      { label: "Generated", render: (item) => `<span class="timestamp">${esc(fmtDate(pick(item, ["generatedAt", "createdAt", "created_at", "updatedAt"])))}</span>` },
    ], "No Phase 1 outputs returned.")}`);
  }

  async function renderRollout(id) {
    const data = await api(`/api/memory/observatory/phase1/${encodeURIComponent(id)}`);
    view.innerHTML = memoryShell("Rollout detail", `Phase 1 metadata for ${id}. Sensitive content has not been requested.`, `${capabilityNotice(data)}<section class="grid two-column"><article class="card"><div class="card-header"><h2>Metadata</h2>${statusBadge(itemValue(data, ["status", "state"], "available"))}</div>${definitionList(flatFacts(data))}</article><article class="card sensitive-panel"><div class="card-header"><h2>Bounded sensitive content</h2>${badge("confirmation required", "warn")}</div><p class="meta">Each field is fetched separately only after you confirm. Content may include private conversation or tool output.</p><div class="actions card-actions"><button class="button secondary" type="button" data-action="load-rollout-content" data-id="${esc(id)}" data-field="rolloutSummary">Load rollout summary</button><button class="button danger" type="button" data-action="load-rollout-content" data-id="${esc(id)}" data-field="rawMemory">Load raw memory</button></div><div id="sensitive-content"></div></article></section>`, '<a class="button secondary" href="#/memory/rollouts">← Rollouts</a>');
  }

  async function renderMemoryPhase2() {
    const data = await api("/api/memory/observatory/phase2");
    const selected = list(data, ["selectedOutputs", "selected_outputs", "items"]);
    const artifacts = list(data, ["artifacts", "publishedArtifacts"]);
    view.innerHTML = memoryShell("Phase 2", "Global consolidation, selection watermark, materialization consistency, and recall usage.", `${capabilityNotice(data)}<section class="grid metric-grid">${metric("Global job", itemValue(data, ["jobStatus", "status"], "unknown"), "consolidation state")}${metric("Watermark", itemValue(data, ["watermark", "selectionWatermark"], "—"), "selection boundary")}${metric("Selected", selected.length, "Phase 1 outputs")}${metric("Recall usage", data.recallUsage?.total ?? itemValue(data, ["recalls"], 0), "published reads")}</section><section class="grid two-column observatory-section"><article class="card"><div class="card-header"><h2>Materialization</h2>${statusBadge(itemValue(data, ["consistency", "materializationStatus"], "unknown"))}</div>${definitionList({ "Selected outputs": selected.length, "Published artifacts": artifacts.length, "Last run": fmtDate(pick(data, ["lastSuccessAt", "updatedAt", "lastRunAt", "completedAt"])), "Consistency": itemValue(data, ["consistency", "materializationStatus"], "unknown") })}</article><article class="card"><div class="card-header"><h2>Selected outputs</h2>${badge(`${selected.length} selected`, "info")}</div>${selected.length ? `<div class="compact-list">${selected.map((item) => `<span class="path">${esc(itemValue(item, ["sessionId", "session_id", "id"], item))}</span>`).join("")}</div>` : '<p class="meta">No selected outputs returned.</p>'}</article></section>`);
  }

  function artifactDirectoryItem(item) {
    const object = typeof item === "string" ? { name: item, id: item } : item;
    const id = artifactIdOf(object);
    const name = artifactNameOf(object);
    const href = id ? `#/memory/artifact/${encodeURIComponent(id)}` : "";
    return `<li class="artifact-directory-item">${href ? `<a href="${href}">` : ""}<span><strong>${esc(name)}</strong><span class="path">${esc(itemValue(object, ["path", "description"], ""))}</span></span><span class="artifact-directory-meta">${statusBadge(itemValue(object, ["status", "consistency"], "available"))}<span class="meta">${esc(artifactMeasure(object))}</span>${href ? '<span aria-hidden="true">→</span>' : ""}</span>${href ? "</a>" : ""}</li>`;
  }

  async function renderArtifact(id) {
    const data = await api(`/api/memory/observatory/artifacts/${encodeURIComponent(id)}`);
    const artifact = pick(data, ["artifact", "item"], data);
    const items = list(artifact, ["items", "entries", "children"]);
    const name = artifactNameOf(artifact);
    const directory = isArtifactDirectory(artifact);
    const contentData = directory ? null : await api(`/api/memory/observatory/artifacts/${encodeURIComponent(id)}/content`);
    const metadata = { Type: directory ? "Directory" : itemValue(artifact, ["kind", "type"], "File"), Status: itemValue(artifact, ["status", "consistency"], "available"), Updated: fmtDate(pick(artifact, ["modifiedAt", "updatedAt", "mtime", "updated_at"])), [directory ? "Entries" : "Size"]: artifactMeasure(artifact) };
    const body = directory
      ? `<article class="card"><div class="card-header"><h2>Contents</h2>${badge(`${items.length} items`, "info")}</div>${items.length ? `<ul class="artifact-directory-list">${items.map(artifactDirectoryItem).join("")}</ul>` : empty("This directory has no published items.")}</article>`
      : `<article class="card"><div class="card-header"><h2>File content</h2>${badge(contentData?.truncated ? "truncated" : "read only", contentData?.truncated ? "warn" : "info")}</div><pre class="code-block artifact-content">${esc(itemValue(contentData, ["content", "text", "markdown", "value"], ""))}</pre></article>`;
    view.innerHTML = memoryShell(name, `Read-only ${directory ? "directory" : "file"} details.`, `<section class="grid artifact-detail-grid"><aside class="card"><div class="card-header"><h2>Metadata</h2>${statusBadge(metadata.Status)}</div>${definitionList(metadata)}</aside>${body}</section>`, '<a class="button secondary" href="#/memory/overview">← Memory Overview</a>');
  }

  async function renderMemoryLogs() {
    const data = await api("/api/memory/observatory/logs");
    const items = list(data, ["items", "logs", "entries"]);
    const text = typeof data.value === "string" ? data.value : "";
    view.innerHTML = memoryShell("Logs", "Bounded, read-only worker diagnostics.", `${capabilityNotice(data)}<article class="card"><div class="card-header"><h2>Worker log</h2>${badge("bounded", "warn")}</div>${items.length || text ? `<div class="log-view">${text ? `<pre>${esc(text)}</pre>` : items.map((item) => `<div class="log-line"><span class="timestamp">${esc(fmtDate(pick(item, ["timestamp", "time", "createdAt"])))}</span><span>${statusBadge(itemValue(item, ["level", "status"], "info"))}</span><pre>${esc(itemValue(item, ["message", "text", "line"], stringify(item)))}</pre></div>`).join("")}</div>` : empty("No log entries returned.")}</article>`);
  }

  async function loadRolloutContent(id, field, button) {
    const label = field === "rawMemory" ? "raw memory" : "rollout summary";
    const confirmed = await confirmAction(`Load ${label}?`, `This makes a separate request for bounded sensitive ${label} content. It may contain private session data.`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      const data = await api(`/api/memory/observatory/phase1/${encodeURIComponent(id)}/content?field=${encodeURIComponent(field)}`, { signal: undefined });
      const content = itemValue(data, ["content", "text", "value", field], "");
      const target = $("#sensitive-content");
      if (target) target.innerHTML = `<div class="sensitive-result"><div class="card-header"><h3>${esc(label)}</h3>${badge("loaded", "warn")}</div><pre class="code-block">${esc(content)}</pre></div>`;
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }

  async function saveResource(kind, id, revision, button) {
    const content = $("#resource-editor")?.value ?? "";
    button.disabled = true;
    try {
      await api(`/api/${kind}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ content, revision }) });
      toast("Revision saved.");
      await render();
    } catch (error) {
      if (error.status === 409) toast("Revision conflict: reload and merge the latest content.", true);
      else toast(error.message, true);
      button.disabled = false;
    }
  }

  function confirmAction(titleText, message) {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = titleText;
    $("#confirm-message").textContent = message;
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  }

  function promptSessionName(currentName) {
    const dialog = $("#rename-dialog");
    const input = $("#rename-input");
    input.value = currentName || "";
    dialog.showModal();
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm" ? input.value.trim() : ""), { once: true }));
  }

  async function renameSession(id, currentName, button) {
    const name = await promptSessionName(currentName);
    if (!name) return;
    button.disabled = true;
    try {
      const detail = await api(`/api/sessions/${encodeURIComponent(id)}`);
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name, revision: detail.revision }) });
      toast("Session renamed.");
      await renderSessions();
    } catch (error) {
      toast(error.status === 409 ? "Revision conflict: the session changed before rename." : error.message, true);
      button.disabled = false;
    }
  }

  async function deleteSession(id, button) {
    const confirmed = await confirmAction("Delete session?", `Session “${id}” will be moved to the system trash when available. Otherwise it will be permanently deleted. This cannot be undone.`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      const detail = await api(`/api/sessions/${encodeURIComponent(id)}`);
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision: detail.revision }) });
      if (state.selectedSessionId === id) { state.selectedSessionId = ""; state.selectedSessionRevision = ""; }
      toast("Session deleted.");
      await renderSessions();
    } catch (error) {
      toast(error.status === 409 ? error.message : `Delete failed: ${error.message}`, true);
      button.disabled = false;
    }
  }

  async function deleteSkill(id, revision, button) {
    const confirmed = await confirmAction("Delete skill?", `This permanently deletes the authorized SKILL.md resource “${id}”. This cannot be undone.`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      await api(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) });
      toast("Skill deleted.");
      location.hash = "#/skills";
    } catch (error) {
      toast(error.status === 409 ? "Revision conflict: the skill changed before deletion." : error.message, true);
      button.disabled = false;
    }
  }

  function applyTheme(theme) {
    localStorage.setItem("pi-web-theme", theme);
    const effective = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
    document.documentElement.dataset.theme = effective;
    $("meta[name=color-scheme]").content = effective;
  }

  function closeMenu() {
    $("#sidebar").classList.remove("open");
    $("#sidebar-scrim").hidden = true;
    $("#menu-button").setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    const open = $("#sidebar").classList.toggle("open");
    $("#sidebar-scrim").hidden = !open;
    $("#menu-button").setAttribute("aria-expanded", String(open));
  }

  view.addEventListener("submit", (event) => {
    if (event.target.id !== "session-search") return;
    event.preventDefault();
    state.sessionsQuery = new FormData(event.target).get("q")?.toString().trim() || "";
    render();
  });

  view.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, revision } = button.dataset;
    if (action === "retry") render();
    if (action === "disk-refresh") {
      state.diskRefresh = true;
      render();
    }
    if (action === "disk-sort") {
      const sort = button.dataset.sort;
      if (state.diskSort === sort) state.diskOrder = state.diskOrder === "asc" ? "desc" : "asc";
      else {
        state.diskSort = sort;
        state.diskOrder = sort === "name" || sort === "type" ? "asc" : "desc";
      }
      render();
    }
    if (action === "select-session") loadSessionDetail(id);
    if (action === "rename-session") renameSession(id, button.dataset.name, button);
    if (action === "delete-session") deleteSession(id, button);
    if (action === "save-skill") saveResource("skills", id, revision, button);
    if (action === "delete-skill") deleteSkill(id, revision, button);
    if (action === "load-rollout-content") loadRolloutContent(id, button.dataset.field, button);
  });

  const theme = localStorage.getItem("pi-web-theme") || "dark";
  $("#theme-select").value = ["dark", "light", "system"].includes(theme) ? theme : "dark";
  applyTheme($("#theme-select").value);
  $("#theme-select").addEventListener("change", (event) => applyTheme(event.target.value));
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if ($("#theme-select").value === "system") applyTheme("system");
  });
  $("#refresh-button").addEventListener("click", render);
  $("#menu-button").addEventListener("click", toggleMenu);
  $("#sidebar-scrim").addEventListener("click", closeMenu);
  addEventListener("hashchange", render);
  addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });
  if (!location.hash || location.hash === "#") location.hash = "#/overview";
  else render();
})();
