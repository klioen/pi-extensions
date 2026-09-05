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
