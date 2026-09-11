# pi-extensions

Custom pi coding-agent packages. Root `package.json` exposes the umbrella runtime extensions; packages are independently installable under `packages/<name>`.

## Project layout

- `packages/env` — `.env` loader; keep it first when loading the umbrella package.
- `packages/web-access`, `subagents`, `todo`, `plan`, `lark`, `failover`, `memory`, `loop`, `pi-web` — runtime extensions.
- `packages/lark` — keeps `lark-*` skills hidden by default and exposes session-scoped `/lark` opt-in routing.
- `packages/pi-web` — loopback-only Control Deck for sessions, skills, extensions/packages, and memory.
- `packages/plan` — owns the `/plan` and `/init` extensions.
- `packages/sdlc` — reusable SDLC skills only.
- `tests/*.test.mjs` — Node built-in `node:test` coverage for reusable core logic.

## Commands

- Test: `npm test` — healthy output reports all `node:test` tests passing with zero failures.
- `npm run evals:list` — lists `evals/` when present; otherwise reports that none exist.
- No build, lint, format, typecheck, run, or CI command is established in repository configuration; do not invent one.

## Verification

- Run all tests: `npm test`.
- For extension changes, reload or restart pi before manual verification.
- Test `/init` in an isolated temporary project: it must create/update only that project's `AGENTS.md` from repository evidence.
- Test `/plan` in an isolated temporary project: agent `edit`/`write`, `todo_write`, and non-allowlisted shell commands must be blocked; `/plan off` restores the earlier tool set and creates no project file. `todo_write` persists only in session state and never authorizes implementation.
- Never commit credentials, absolute user paths, API keys, or personal data.

## Conventions

- Project instructions live in `AGENTS.md`, never `CLAUDE.md`.
- Packages are under `packages/<name>`; Node built-in `node:test` is the test framework.
- Root runtime extension order is `env`, `web-access`, `subagents`, `todo`, `plan`, `lark`, `failover`, `memory`, `loop`, `pi-web`.
- Runtime dependencies must be zero or declared in `dependencies`; pi core packages are peer-provided.
- `pi-plan` owns `/plan` and `/init`; `pi-sdlc` ships reusable skills under `skills/`.

## Things pi gets wrong

- Do not claim unverified project commands, CI behavior, ownership, or safety policies as facts.
- Extension changes require `/reload` or a pi restart; a current session can retain old extension behavior.
