# pi-extensions

Custom pi coding-agent packages. Root `package.json` exposes the umbrella runtime extensions; packages are independently installable under `packages/<name>`.

## Project layout

- `packages/env` — `.env` loader; keep it first when loading the umbrella package.
- `packages/web-access`, `subagents`, `failover`, `memory`, `loop` — runtime extensions.
- `packages/sdlc` — reusable SDLC skills plus the `/init` extension.
- `tests/*.test.mjs` — Node built-in `node:test` coverage for reusable core logic.

## Commands

- Test: `npm test` — healthy output reports all `node:test` tests passing with zero failures.
- No build, lint, format, typecheck, run, or CI command is established in repository configuration; do not invent one.

## Verification

- Run all tests: `npm test`.
- For extension changes, reload or restart pi before manual verification.
- Test `/init` in an isolated temporary project: it must create/update only that project's `AGENTS.md` from repository evidence.
- Test `/plan` in an isolated temporary project: agent `edit`/`write` and non-allowlisted shell commands must be blocked; `/plan off` restores the earlier tool set and creates no project file. `update_plan` must persist only in session state and never authorize implementation.
- Never commit credentials, absolute user paths, API keys, or personal data.

## Conventions

- Project instructions live in `AGENTS.md`, never `CLAUDE.md`.
- Packages are under `packages/<name>`; Node built-in `node:test` is the test framework.
- Runtime dependencies must be zero or declared in `dependencies`; pi core packages are peer-provided.
- `pi-sdlc` ships both reusable skills (`skills/`) and the `/init` extension (`extensions/`).

## Things pi gets wrong

- Do not claim unverified project commands, CI behavior, ownership, or safety policies as facts.
