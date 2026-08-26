# ADR 0012 — AI vendor privacy (Phase 2B, not enabled)

**Status:** Deferred  
**Date:** 2026-08-26

## Context

Production LLM APIs require documented commercial terms, training/data-use, retention, DPA, subprocessors, zero-retention controls, and region controls.

## Decision

Phase 2A ships only `FakeAIProvider`. No real AI SDK, no API keys in runtime config, no production or sandbox vendor calls. Phase 2B cannot start until this ADR is rewritten as Accepted with a named provider and license review of that version.

## Consequences

CI remains deterministic. Intent extraction in 2A is scripted for Hebrew fixtures.
