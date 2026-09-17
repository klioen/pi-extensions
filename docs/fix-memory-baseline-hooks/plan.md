# Plan: Prevent memory baseline commits from invoking user hooks

## Files that change

- `packages/memory/worker/worker.cjs`: bypass user Git hooks for private memory baseline commits.
- `tests/memory-worker.test.mjs`: guard the baseline commit arguments against regression.
- `docs/fix-memory-baseline-hooks/{intent,spec,plan}.md`: record the approved bugfix.

## Order of work

1. Add a source-level regression test that requires the baseline commit to use `--no-verify`.
2. Run the focused test and confirm it fails for the current implementation.
3. Add `--no-verify` to the single baseline commit path used by initialization and reset.
4. Run the focused test and the root test suite.

## Risks

The dangerous alternative is changing `core.hooksPath` globally or locally, which could weaken validation for unrelated user commits. `--no-verify` is scoped to the private implementation-only commit and leaves user repositories untouched. The baseline remains local and disposable, so bypassing hooks does not alter product source validation.

## Proof

- `node --disable-warning=ExperimentalWarning --test tests/memory-worker.test.mjs`
- `npm test`
- No residual `~/.bytesec/commit_hook/pre-commit` process remains after cleanup.
