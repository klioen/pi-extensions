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

### pi-env — `packages/env`

Loads pi-specific dotenv files into the pi process — configure secrets/vars for pi without polluting your global shell environment.

- Files: global `~/.pi/agent/.env` + project `.pi/.env` (project keys override global)
- Precedence per key: real `process.env` (never overwritten) > project `.pi/.env` > global `~/./pi/agent/.env`
- Parsed at module load time, before later packages in the settings list are imported — extensions reading env at module scope pick values up. **Keep pi-env first in the packages list.**
- Loaded vars also propagate to `bash` tool child processes.
- Format: `KEY=VALUE` per line; supports `export` prefix, quotes, `#` comments
- `/env` command lists loaded variables with masked values

### pi-failover — `packages/failover`

Automatic multi-API-key failover for OpenAI-compatible providers (default **ark**), with no proxy in between. When a key hits a rate limit (`429` / `AccountQuotaExceeded` / `TooManyRequests` / quota …) *before* any token is produced, the same request is transparently retried with the next key; rate-limited keys are put on a short cooldown.

- Overrides the provider's `streamSimple` and forwards the official `openai-completions` stream live (no buffering) — the caller keeps real streaming. Because a provider 429 arrives before the response body, a limited attempt never emits content, so the switch is invisible.
- Only activates with ≥2 keys; otherwise the provider is untouched.

```bash
export ARK_API_KEYS="key1,key2,key3"        # comma-separated pool (or ARK_API_KEY + ARK_API_KEY_2 … _N)
```

Config (env): `ARK_API_KEYS`, `ARK_API_KEY[_2.._N]`, `PI_FAILOVER_PROVIDER` (default `ark`), `PI_FAILOVER_COOLDOWN_MS` (default 60000).

### pi-memory — `packages/memory`

Local markdown-file memory for pi, modeled after **Codex's memory system** (`codex-rs/memories/write` + `ext/memories`): progressive disclosure over a plain directory, with a two-phase LLM distillation pipeline and per-turn recall injection. No server, no proxy.

**Storage layout** (under `~/.pi/agent/memories/` or `PI_MEMORY_DIR`):

- `memory_summary.md` — dense, always injected into the system prompt; first line must be `v1`
- `MEMORY.md` — durable handbook; `# Task Group` blocks with `scope:`/`applies_to:` headers, per-task `rollout_summary_files` + `keywords`, and consolidated `## User preferences` / `## Reusable knowledge` / `## Failures and how to do differently` sections
- `raw_memories.md` — merged phase-1 outputs (phase-2 input)
- `rollout_summaries/<timestamp>-<slug>.md` — per-conversation distilled recaps
- `skills/<name>/` — optional reusable procedures (`SKILL.md` packages)

**Pipeline** (both phases are tool-less LLM sessions, exactly like Codex):

- **Phase 1** (per `agent_settled`, low reasoning): distills new conversation turns into `{raw_memory, rollout_summary, rollout_slug}` — with `Preference signals:` / `Reusable knowledge:` / `Failures and how to do differently:` sections — appended to `raw_memories.md` and `rollout_summaries/`. Sync state persists in the session file (no duplicate extraction across turns/resumes).
- **Phase 2** (every N phase-1 runs, default 3, or `/memory consolidate`, medium reasoning): consolidates raw memories + existing artifacts + a git-style workspace diff into fresh `MEMORY.md` and `memory_summary.md`; drives incremental updates and forgetting (deleted rollout inputs → surgical memory cleanup).

**Recall** (every `before_agent_start`): `memory_summary.md` is injected into the system prompt with a decision boundary ("skip memory only when clearly self-contained") and a lightweight quick-pass (≤4–6 search steps), mirroring Codex's `read_path.md`.

Config (env): `PI_MEMORY_DIR`, `PI_MEMORY_AUTO=0` (disable phase 1), `PI_MEMORY_RECALL=0` (disable injection), `PI_MEMORY_CONSOLIDATE_EVERY`, `PI_MEMORY_SUMMARY_TOKENS`, `PI_MEMORY_ROLLOUT_CHARS`, `PI_MEMORY_MEMORY_CHARS`.

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
