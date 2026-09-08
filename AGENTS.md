# pi-extensions

Custom pi coding-agent packages. Root `package.json` exposes the umbrella runtime extensions; packages are independently installable under `packages/<name>`.

## Project layout

- `packages/env` — `.env` loader; keep it first when loading the umbrella package.
- `packages/web-access`, `subagents`, `failover`, `memory`, `loop` — runtime extensions.
- `packages/sdlc` — reusable SDLC skills plus the `/init` extension.
- `tests/*.test.mjs` — Node built-in `node:test` coverage for reusable core logic.

## Development workflow

- Any repository change follows `sdlc-build`: read-only reconnaissance, a written `plan.md`, explicit user approval, then implementation and verification.
- Do not infer approval. No `edit`, `write`, destructive shell command, or implementation commit before explicit approval.
- Keep plans and implementation auditable in Git.
- Do not change dependency versions unless explicitly requested.

## Commands

- Test: `npm test` — healthy output reports all `node:test` tests passing with zero failures.
- No build, lint, format, typecheck, run, or CI command is established in repository configuration; do not invent one.

## Verification

- Run all tests: `npm test`.
- For extension changes, reload or restart pi before manual verification.
- Test `/init` in an isolated temporary project: it must create/update only that project's `AGENTS.md` from repository evidence.
- Never commit credentials, absolute user paths, API keys, or personal data.

## Conventions

- Project instructions live in `AGENTS.md`, never `CLAUDE.md`.
- Packages are under `packages/<name>`; Node built-in `node:test` is the test framework.
- Runtime dependencies must be zero or declared in `dependencies`; pi core packages are peer-provided.
- `pi-sdlc` ships both reusable skills (`skills/`) and the `/init` extension (`extensions/`).

## Things pi gets wrong

- Do not implement even a small change before the user explicitly approves the written `plan.md`. A request to proceed, a prior discussion, or a stated intent to approve is not approval.
- Do not claim unverified project commands, CI behavior, ownership, or safety policies as facts.
