# Plan: Configurable Memory Phase 1 reasoning

## Files that change

- `packages/memory/lib/memory-core.cjs`: validate and resolve the Phase 1 reasoning environment variable.
- `tests/memory-core.test.mjs`: cover default, configured, and invalid values while preserving Phase 2 behavior.
- `docs/memory-extract-thinking/{intent,spec,plan}.md`: record the approved change.

## Order of work

1. Add a failing test for configured and invalid values.
2. Implement a strict allowlist resolver and use it in Phase 1 arguments.
3. Run the focused Memory test and root test suite.

## Risks

An arbitrary string passed to `--thinking` could break background extraction. A fixed allowlist and `low` fallback prevent that. Phase 2 is intentionally unchanged.

## Proof

- `node --disable-warning=ExperimentalWarning --test tests/memory-core.test.mjs`
- `npm test`
