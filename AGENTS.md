# pi-extensions

Custom pi coding-agent packages. Root `package.json` exposes the umbrella runtime extensions; packages are independently installable under `packages/<name>`.

## Project layout

- `packages/env` — `.env` loader; keep it first when loading the umbrella package.
- `packages/web-access`, `subagents`, `todo`, `plan`, `lark`, `failover`, `memory`, `loop`, `pi-web` — runtime extensions.
- `packages/lark` — keeps `lark-*` skills hidden by default and exposes session-scoped `/lark` opt-in routing.
- `packages/pi-web` — loopback-only React/TypeScript Control Deck for chat, sessions, skills, extensions/packages, disk usage, and memory; Vite source is under `src/`, committed runtime assets under `public/`.
- `packages/plan` — owns the `/plan` and `/init` extensions.
- `packages/sdlc` — reusable SDLC skills only.
- `tests/*.test.mjs` — Node built-in `node:test` coverage for reusable core logic.

## Commands

- Test: `npm test` — healthy output reports all root `node:test` and pi-web Vitest tests passing with zero failures.
- Pi Web typecheck: `npm run pi-web:typecheck`.
- Pi Web production build: `npm run pi-web:build`; commit the generated `packages/pi-web/public/` assets with matching source changes.
- Pi Web asset drift check: `npm run pi-web:verify-public` builds into a temporary directory and byte-compares it with committed `public/` without modifying `public/`; root `npm test` includes this gate.
- Pi Web development server: `npm run pi-web:dev`; it proxies `/api` to loopback `PI_WEB_PORT` (default `8787`).
- `npm run evals:list` — lists `evals/` when present; otherwise reports that none exist.
- No repository-wide lint, format, or CI command is established; do not invent one.

## Verification

- Run all tests: `npm test`.
- For pi-web frontend changes also run `npm run pi-web:typecheck`, `npm run pi-web:build`, and `npm run pi-web:verify-public`.
- For extension changes, reload or restart pi before manual verification.
- Test `/init` in an isolated temporary project: it must create/update only that project's `AGENTS.md` from repository evidence.
- Test `/plan` in an isolated temporary project: agent `edit`/`write`, `todo_write`, and non-allowlisted shell commands must be blocked; `/plan off` restores the earlier tool set and creates no project file. `todo_write` persists only in session state and never authorizes implementation.
- Never commit credentials, absolute user paths, API keys, or personal data.

## Conventions

- Project instructions live in `AGENTS.md`, never `CLAUDE.md`.
- Packages are under `packages/<name>`; Node built-in `node:test` is the test framework.
- Root runtime extension order is `env`, `web-access`, `subagents`, `todo`, `plan`, `lark`, `failover`, `memory`, `loop`, `pi-web`.
- Runtime dependencies must be zero or declared in `dependencies`; pi core packages are peer-provided. Pi Web frontend dependencies are bundled by Vite, and extension/server code must not import them at runtime.
- `packages/pi-web/public/` is generated but committed because installed pi packages serve it without a frontend build step; never hand-edit its hashed assets.
- `pi-plan` owns `/plan` and `/init`; `pi-sdlc` ships reusable skills under `skills/`.

## Things pi gets wrong

- Do not claim unverified project commands, CI behavior, ownership, or safety policies as facts.
- Extension changes require `/reload` or a pi restart; a current session can retain old extension behavior.
