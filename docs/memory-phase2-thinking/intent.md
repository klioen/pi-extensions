# Intent: Configurable Memory Phase 2 reasoning
Author: SpireCode integration. Status: accepted.

## Problem
Pi Memory hard-codes Phase 2 subprocess reasoning to `medium`, so hosts cannot configure both memory phases independently.

## Proposed outcome
Allow Phase 2 `pi --print` to read a validated reasoning level from `PI_MEMORY_PHASE2_THINKING`, preserving `medium` as default and fallback.

## Affected users and systems
Pi Memory worker users and hosts configuring memory processing.

## Constraints
Only supported Pi thinking levels are accepted. Phase 1 behavior remains unchanged.

## Open questions
None.
