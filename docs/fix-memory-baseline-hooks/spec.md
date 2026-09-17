# Spec: Prevent memory baseline commits from invoking user hooks
Status: accepted. Implements: `docs/fix-memory-baseline-hooks/intent.md`.

## Behavior

Every Git commit used to initialize or reset Pi Memory's private workspace baseline includes `--no-verify`.

This prevents global or repository Git hooks from running for the implementation-only baseline. It does not affect Git commands executed in user repositories.

## Acceptance

- The baseline commit arguments include `--no-verify`.
- The existing `--allow-empty`, quiet mode, and `memory baseline` message remain intact.
- A regression test fails if the worker baseline command loses `--no-verify`.
- Root tests pass.
