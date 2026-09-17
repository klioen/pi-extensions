# Plan: Configurable Memory Phase 2 reasoning

## Files that change
- `packages/memory/lib/memory-core.cjs`: resolve Phase 2 reasoning from a strict environment allowlist.
- `tests/memory-core.test.mjs`: cover default, configured, and invalid Phase 2 values.
- `docs/memory-phase2-thinking/{intent,spec,plan}.md`: approved artifacts.

## Order of work
1. Add the failing configured-reasoning test.
2. Reuse the strict thinking-level resolver for both phases with different defaults.
3. Run focused and full tests.

## Risks
An invalid level could break background consolidation; strict allowlisting and `medium` fallback prevent it. Phase 1 remains independent.

## Proof
- `node --disable-warning=ExperimentalWarning --test tests/memory-core.test.mjs`
- `npm test`
