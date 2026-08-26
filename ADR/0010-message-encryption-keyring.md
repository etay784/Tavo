# ADR 0010 — Separate message encryption keyring

**Status:** Accepted (Phase 2A)  
**Date:** 2026-08-26

## Context

Conversation bodies are PII. Reusing phone encryption keys couples two purposes and complicates rotation.

## Decision

- Env `TAVO_MESSAGE_ENCRYPTION_KEYS` + `TAVO_MESSAGE_ENCRYPTION_WRITE_VERSION`.
- Same AES-256-GCM packing as phones; distinct keyring and `message_encryption_key_version` on `messages` / inbound / outbox bodies.
- Decrypt with the row version; writes use the current write version.

## Consequences

Phone key rotation does not decrypt chat history. Tests must fail decrypting a message with a phone key.
