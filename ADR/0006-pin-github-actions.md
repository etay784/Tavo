# ADR 0006 — Pin GitHub Actions to commit SHAs

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

Mutable tags (`v4`, `v7`) can be retargeted. Supply-chain defense for CI is to pin third-party actions to an immutable git commit.

## Decision

Pin `uses:` lines to 40-character SHAs, with the human version in a trailing comment:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

Secret scanning uses the **gitleaks CLI** (MIT), not `gitleaks/gitleaks-action` (not on the license allowlist; org license key required). The CLI version is pinned (`8.30.1`) and the archive SHA-256 is verified before execution.

## Current pins

| Action | Version | SHA |
| --- | --- | --- |
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| actions/upload-artifact | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
