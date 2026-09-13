# Plan: Rename pi-loop to pi-goal (from docs/rename-pi-loop-to-pi-goal/spec.md 2026-09-13)

## Files that change
- Rename `packages/loop/` to `packages/goal/`.
- Rename `packages/goal/extensions/loop.ts` to `packages/goal/extensions/goal.ts`.
- Rename `tests/loop-core.test.mjs` to `tests/goal-core.test.mjs`.
- Update `packages/goal/package.json`, extension/core comments and identifiers, root `package.json`, `package-lock.json`, and `AGENTS.md`.
- Add a regression assertion to `tests/goal-core.test.mjs` for retired identifiers.
- Add this change's `intent.md`, `spec.md`, and `plan.md`.

## Order of work
1. Record the approved intent, specification, and implementation plan.
2. Rename the package directory, extension entry, and test file.
3. Replace package-specific names, environment variables, diagnostics, message types, imports, and runtime documentation.
4. Regenerate `package-lock.json` from workspace manifests.
5. Search tracked source for stale `pi-loop`, `packages/loop`, `PI_LOOP`, and `loop-core` references.
6. Run the focused goal-core test and the full `npm test` suite.

## Risks
- The most dangerous step is lockfile regeneration: an incomplete workspace rename can leave both old and new package identities.
- Renaming environment variables is intentionally breaking for configured users; the accepted spec requires a comprehensive rename rather than compatibility aliases.
- Renaming the default database file was rejected because it would hide existing goals. The filename stays `goal.db`.
- Blind replacement of every word `loop` was rejected because unrelated control loops and descriptions of auto-continuation are valid.

## Proof
- `node --test tests/goal-core.test.mjs`
- A tracked-source search returns no retired package/config identifiers outside this SDLC history.
- `npm test` exits zero, including root Node tests and Pi Web tests/public-asset verification.
