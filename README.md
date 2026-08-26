# Tavo

Multi-tenant AI receptionist platform (first vertical: barbershops). Product specification: `AI_Receptionist_Product_Specification.md`.

Phase 1 is the deterministic booking core (no WhatsApp, payments, LLM, or dashboard).

## Docs

`ARCHITECTURE.md`, `SECURITY.md`, `DATA_MODEL.md`, `THREAT_MODEL.md`, `LICENSE_POLICY.md`, `ADR/`

## Layout

```text
apps/api              Internal Fastify harness (credential → tenant)
packages/database     SQL migrations + pg repositories
packages/domain       Scheduling and appointments
packages/security     Phone HMAC/encrypt, redaction
packages/shared       Errors, clock, tenant context type
```

## Commands

```text
npm install
npm test
npm run typecheck
npm run lint
npm run lint:licenses
npm run secrets
npm run audit:prod
npm run notices
```

Tests start an ephemeral PostgreSQL via `initdb` (set `PGBIN` if binaries are not in the default install path). Runtime must connect as `tavo_app`. See `.env.example`.
