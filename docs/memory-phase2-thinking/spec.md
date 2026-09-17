# Spec: Configurable Memory Phase 2 reasoning
Status: accepted. Implements: `docs/memory-phase2-thinking/intent.md`.

`phase2PiArgs()` reads `PI_MEMORY_PHASE2_THINKING`. Supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; missing, empty, or unknown values use `medium`. Phase 1 keeps its independent `PI_MEMORY_EXTRACT_THINKING` behavior.

Acceptance: configured Phase 2 reasoning is forwarded to `--thinking`, invalid values fall back to `medium`, and Phase 1 remains independent.
