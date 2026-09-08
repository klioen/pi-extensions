# pi-extensions

## Development workflow

- Any repository change follows `sdlc-build`: read-only reconnaissance, a written `plan.md`, explicit user approval, then implementation and verification.
- Do not infer approval. No `edit`, `write`, destructive shell command, or implementation commit before explicit approval.
- Keep plans and implementation auditable in Git.

## Verification

- Run all tests: `npm test`.
- For extension changes, reload or restart pi before manual verification.
- Never commit credentials, absolute user paths, API keys, or personal data.

## Conventions

- Project instructions live in `AGENTS.md`, never `CLAUDE.md`.
- Packages are under `packages/<name>`; Node built-in `node:test` is the test framework.
