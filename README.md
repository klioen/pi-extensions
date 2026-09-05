# pi-extensions

Custom extensions for the [pi coding agent](https://github.com/earendil-works/pi-mono), packaged as a pi package.

## Extensions

### web_search

Searches the public web and returns per-result summaries. Ported from mpa-agent's `app/runtime/tools/web_search.py` (veadk `ve_request` signing; API details in the extension source).

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

Tools are named `web_search` and `web_fetch`. If the pi-web-access extension is also installed, disable it or its tools to avoid name collisions with `web_search`.

### web_fetch

Fetches a URL and returns markdown (default), plain text, html, or an image attachment. Ported from mpa-agent's `app/runtime/tools/web_fetch.py` (modeled after opencode's webfetch). Includes SSRF protection (private/loopback/metadata addresses blocked, every redirect hop re-validated), 5MB size cap, manual redirect following (max 5), Cloudflare challenge retry, and charset detection. HTML to markdown conversion is dependency-free and covers common structural tags.
