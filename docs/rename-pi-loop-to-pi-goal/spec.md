# Spec: Rename pi-loop to pi-goal
Status: accepted. Date: 2026-09-13.

## Requirements
1. The standalone package name is `pi-goal` and its package directory is `packages/goal`.
2. The extension entry filename is `extensions/goal.ts`.
3. Root package loading and runtime-order documentation refer to `goal` in the existing position between `memory` and `pi-web`.
4. All extension-owned identifiers and user-visible labels change from `pi-loop` to `pi-goal`, including diagnostic prefixes and custom message types.
5. Configuration uses `PI_GOAL`, `PI_GOAL_DB`, `PI_GOAL_DEBUG`, `PI_GOAL_MAX_TURNS`, and `PI_GOAL_MAX_GOAL_TOKEN_BUDGET`.
6. Tests and imports use `goal` naming.
7. The default SQLite path remains `~/.pi/agent/sqlite/goal.db` and the schema remains compatible.
8. Generic descriptions of automatic looping may retain the word `loop` where it describes behavior rather than package identity.

## Design
- Move the package and test files with history-preserving filesystem renames.
- Replace package-identity strings and extension-owned configuration names.
- Regenerate the npm lockfile so its workspace package resolution points to `packages/goal` and `pi-goal`.
- Add a deterministic repository test asserting that retired package/config identifiers do not return.

## Compatibility
This is an intentional package/configuration rename. Existing `PI_LOOP_*` variables are not retained as aliases. Existing persisted data remains discoverable because the default database filename and schema do not change.

## Concerns
- Installed standalone consumers must change from `pi-loop` to `pi-goal`.
- Local environment configurations using `PI_LOOP_*` must be migrated.
- A stale lockfile could keep the retired workspace name; lockfile regeneration is mandatory.
