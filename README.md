# pi-extensions

Custom extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono), packaged as a pi package.

## Extensions

### volc_web_search

Searches the public web through Volcano Engine WebSearch (`mercury.volcengineapi.com`, Action `WebSearch`) and returns per-result summaries. Ported from mpa-agent's `app/runtime/tools/web_search.py` (veadk `ve_request` signing).

Credentials are resolved in this order:

1. `TOOL_WEB_SEARCH_ACCESS_KEY` + `TOOL_WEB_SEARCH_SECRET_KEY`
2. `VOLCENGINE_ACCESS_KEY` + `VOLCENGINE_SECRET_KEY`
3. IAM credential JSON: file at `VOLCENGINE_CREDENTIAL_FILE`, or raw JSON in `IAM_CREDENTIAL`
   (fields: `access_key_id`, `secret_access_key`, optional `session_token`)

## Install

Local (development):

```
pi install /path/to/pi-extensions
```

Or link it directly in `~/.pi/agent/settings.json`:

```json
{
	"packages": ["/Users/bytedance/Code/pi-extensions"]
}
```

Remote (after pushing to GitHub):

```
pi install git:github.com/<user>/pi-extensions
```

Extensions in `extensions/` are auto-discovered via the `pi` manifest in `package.json`. Edit a file and run `/reload` in pi to pick up changes (local path installs only).

## Development

No build step: pi loads TypeScript directly. Runtime deps must be zero or listed in `dependencies`; pi core packages (`@earendil-works/pi-coding-agent`, `typebox`, ...) are peer-provided and must not be bundled.

Tool name is `volc_web_search` (not `web_search`) to avoid colliding with the pi-web-access extension.
