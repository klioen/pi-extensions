# pi-extensions

Custom packages for the [pi coding agent](https://github.com/earendil-works/pi-mono). Two independent packages live here; install either one or both.

## Packages

### pi-web-access — `packages/web-access`

- **web_search** — searches the public web and returns per-result summaries. Ported from mpa-agent's `app/runtime/tools/web_search.py` (veadk `ve_request` signing; API details in the extension source).
  Credentials: `TOOL_WEB_SEARCH_ACCESS_KEY`/`SECRET_KEY` → `VOLCENGINE_ACCESS_KEY`/`SECRET_KEY` → IAM credential JSON (`VOLCENGINE_CREDENTIAL_FILE` file or `IAM_CREDENTIAL` env; fields `access_key_id`, `secret_access_key`, optional `session_token`).
- **web_fetch** — fetches a URL and returns markdown (default), plain text, html, or an image attachment. Ported from mpa-agent's `web_fetch.py` (modeled after opencode's webfetch). SSRF protection (private/loopback/metadata addresses blocked, every redirect hop re-validated), 5MB cap, manual redirects (max 5), Cloudflare challenge retry, charset detection. HTML→markdown conversion is dependency-free.

If the community pi-web-access extension is also installed, disable it to avoid `web_search` name collisions.

### pi-subagents — `packages/subagents`

Background subagents modeled after codex's `multi_agent_v1` tool surface. Each subagent is an in-process pi `AgentSession` (in-memory history) with its own context window, a restricted tool allowlist (default `read` + `bash`), and the parent's current model.

- **spawn_agent** — start a background agent with a self-contained task; returns immediately
- **wait_agent** — wait for all (or listed) agents and return their final messages
- **send_input** — follow up with an agent; reuses its accumulated context
- **list_agents** — status overview
- **close_agent** — abort and release an agent (or `all`)

Up to 8 agents run in parallel; cleaned up on session shutdown.

### pi-memory — `packages/memory`

Persistent memory backed by an **OpenViking server** — a faithful port of vikingbot's OpenViking integration (`bot/vikingbot/agent/tools/ov_file.py` + `agent/memory.py` + `agent/context.py`). Zero runtime dependencies; the OpenViking HTTP API is called with fetch (mirroring `@openviking/sdk`'s transport).

- **Tools** (same names/semantics as vikingbot):
  - `openviking_search` — semantic retrieval over memories/resources/skills with score filtering and grouped JSON output (0.35 default min_score)
  - `openviking_multi_read` — concurrent full-content reads with bounded offset/limit; inline image attachment (max 4), audio/video via L1 overview
  - `openviking_list` / `openviking_grep` / `openviking_glob` — browse and pattern-search Viking content
  - `openviking_add_resource` — import a URL or local file (async server-side indexing)
  - `openviking_memory_commit` — explicit "remember this": commits the minimal relevant messages to a dedicated `{session}__memory_commit__{ts}__{seq}` OV session with vikingbot's peer memory policy, polls the extraction task (20×0.5s), and reports `memory_diff.json` added/updated/deleted URIs
- **Auto recall** (every turn, before the agent runs): type-quota search (events/entities/preferences, 10/10/3) against the memory target with three-level degradation — full content → event summary → URI-only — under a character budget (6500), injected as `## openviking_search(query=[user_query])` plus the memory-retrieval guidance block, exactly like vikingbot's `_build_user_memory`. profile.md is filtered out; failures never break the conversation.
- **Auto session sync** (every turn, after the agent settles — vikingbot `openviking_hooks.py`): unsynced user/assistant messages are appended to a stable OpenViking session named after the pi session id; when the pending message count or token estimate crosses a threshold, the session is committed (`keep_recent_count`) and the server extracts memories asynchronously. Sync state is persisted in the pi session file via a custom entry (survives restart/resume); failures never break the conversation.
- **Command** — `/memory` shows connection info and recall config.

Config (env): `OPENVIKING_SERVER_URL` + `OPENVIKING_API_KEY` (required; extension no-ops with a warning if unset), `OPENVIKING_ACCOUNT` / `OPENVIKING_USER` headers, `PI_MEMORY_USER_URI` (user scope base URI, default `viking://user/default`), `PI_MEMORY_PEER_ID` (routes memory to `…/peers/{peer}/memories/` and enables the peer memory policy), `PI_MEMORY_EVENTS_LIMIT` / `PI_MEMORY_ENTITIES_LIMIT` / `PI_MEMORY_PREFERENCES_LIMIT`, `PI_MEMORY_RECALL_MAX_CHARS`, `PI_MEMORY_RECALL=0` to disable injection. Auto sync: `PI_MEMORY_AUTO_SYNC=0` to disable, `PI_MEMORY_MEMORY_WINDOW` (commit after N pending messages, default 50), `PI_MEMORY_COMMIT_TOKENS` (token estimate threshold, default 200000), `PI_MEMORY_KEEP_RECENT` (messages kept on commit, default 10).

### pi-env — `packages/env`

Loads pi-specific dotenv files into the pi process — configure secrets/vars for pi without polluting your global shell environment.

- Files: global `~/.pi/agent/.env` + project `.pi/.env` (project keys override global)
- Precedence per key: real `process.env` (never overwritten) > project `.pi/.env` > global `~/./pi/agent/.env`
- Parsed at module load time, before later packages in the settings list are imported — extensions reading env at module scope (e.g. pi-memory) pick values up. **Keep pi-env first in the packages list.**
- Loaded vars also propagate to `bash` tool child processes.
- Format: `KEY=VALUE` per line; supports `export` prefix, quotes, `#` comments
- `/env` command lists loaded variables with masked values

## Install

Single packages (local paths):

```
pi install /path/to/pi-extensions/packages/web-access
pi install /path/to/pi-extensions/packages/subagents
```

Or both at once via the umbrella package:

```
pi install /path/to/pi-extensions
```

Remote (after pushing to GitHub), e.g. for subagents only:

```
pi install git:github.com/klioen/pi-extensions
```

Note: git installs always fetch the whole repo; to expose only one package remotely, publish it to npm separately or filter resources in settings:

```json
{
	"packages": [
		{
			"source": "git:github.com/klioen/pi-extensions",
			"extensions": ["packages/web-access/extensions/*.ts"]
		}
	]
}
```

## Development

No build step: pi loads TypeScript directly. Runtime deps must be zero or listed in `dependencies`; pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `typebox`) are peer-provided and must not be bundled.

For local path installs, edit a file and run `/reload` in pi to pick up changes.
