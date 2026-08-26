# ADR 0005 — Phone HMAC lookup during key rotation

**Status:** Accepted (Phase 1)  
**Date:** 2026-08-26

## Context

Phone lookup must remain a keyed HMAC, not an unsalted hash. Encryption keys will rotate independently of HMAC keys. A background re-HMAC job is not required for Phase 1, but lookup must not break when a new HMAC version becomes the write version.

Columns:

- `phone_lookup_hash` / `phone_lookup_key_version` — HMAC of the normalized phone and which HMAC key produced it
- `phone_encrypted` / `phone_encryption_key_version` — ciphertext and which encryption key decrypts it (the encryption key version; not a separate column named `encryption_key_version`)

## Decision

No rotator service in Phase 1.

**Writes:** HMAC and encrypt with the configured *write* versions; store those versions on the row.

**Reads:** HMAC the normalized phone with **every version in the HMAC keyring** and match `(phone_lookup_key_version, phone_lookup_hash)` against any of those pairs.

A later job may rewrite rows to the newest HMAC version and then drop old keyring entries. Until then, old keys stay in the keyring.

Encryption: decrypt with the row’s `phone_encryption_key_version`; new writes use the current encryption write version. Keep old encryption keys until ciphertext is re-encrypted.

## Consequences

Customer identity survives HMAC write-version bump without a migration job. Keyrings live in secrets, not in PostgreSQL.
