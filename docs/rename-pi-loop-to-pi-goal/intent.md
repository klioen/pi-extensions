# Intent: Rename pi-loop to pi-goal
Author: user. Status: accepted.

## Problem
The persistent-goal extension is named `pi-loop` even though its public capability and command are goals. The package, directory, environment variables, diagnostics, and tests use inconsistent loop-oriented naming.

## Proposed outcome
Rename the extension comprehensively from `pi-loop` to `pi-goal` while preserving its goal behavior and existing SQLite goal data.

## Affected users and systems
- Users installing the standalone npm package.
- Umbrella `pi-extensions` package loading the runtime extension.
- Users configuring the extension through environment variables.
- Repository tests and contributor documentation.

## Constraints
- Rename `packages/loop` to `packages/goal` and `pi-loop` to `pi-goal` consistently.
- Rename `PI_LOOP_*` configuration to `PI_GOAL_*`.
- Preserve the existing default database path `~/.pi/agent/sqlite/goal.db` so stored goals are not lost.
- Preserve `/goal`, `create_goal`, `update_goal`, and `get_goal` behavior.
- Do not alter unrelated uses of the generic word `loop`.

## Open questions
None. The complete rename scope was approved by the user on 2026-09-13.
