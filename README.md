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
