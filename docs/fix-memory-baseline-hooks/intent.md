# Intent: Prevent memory baseline commits from invoking user hooks
Status: accepted.

## Problem

Pi Memory creates and refreshes an internal Git baseline under its private memory workspace. Those implementation-only commits currently invoke the user's global Git hooks. An interactive ByteSec pre-commit hook can write directly to `/dev/tty`, overlap Pi's TUI, outlive the timed-out Git process, and repeat on later Pi startups when the baseline was never created.

## Proposed outcome

Make Pi Memory's internal baseline commits bypass user-configured Git hooks while leaving normal repository commits unchanged.

## Constraints

- Apply only to the private memory workspace baseline commit.
- Do not change or disable the user's global Git hook configuration.
- Preserve the existing baseline commit message and reset behavior.
- Add deterministic regression coverage.
