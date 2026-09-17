# Spec: Configurable Memory Phase 1 reasoning
Status: accepted. Implements: `docs/memory-extract-thinking/intent.md`.

## Behavior

`phase1PiArgs()` reads `PI_MEMORY_EXTRACT_THINKING` each time it constructs the Phase 1 subprocess arguments.

Allowed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Missing, empty, or unknown values resolve to `low`.

The resolved value is passed after `--thinking`. Phase 2 continues to pass `medium` and does not read this variable.

## Acceptance

- Default Phase 1 reasoning is `low`.
- A supported configured value is forwarded.
- An unsupported value falls back to `low`.
- Phase 2 remains `medium`.
- Root tests pass.
