# Intent: Configurable Memory Phase 1 reasoning
Author: SpireCode integration. Status: accepted.

## Problem
Pi Memory hard-codes Phase 1 subprocess reasoning to `low`, so hosts cannot expose a real Memory reasoning configuration.

## Proposed outcome
Allow the Phase 1 `pi --print` subprocess to read a validated reasoning level from `PI_MEMORY_EXTRACT_THINKING`, preserving `low` as the default and fallback.

## Affected users and systems
Pi Memory worker users and hosts that configure the bundled extension.

## Constraints
- Accept only Pi's supported thinking levels.
- Invalid or missing values fall back to `low`.
- Phase 2 remains fixed at `medium`.
- No credentials or paths are added to configuration.

## Open questions
None.
