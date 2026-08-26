import { describe, expect, it } from "vitest";
import {
  lookupCandidates,
  normalizePhone,
  parseKeyring,
  redact,
  sealPhone,
  decryptPhone,
} from "./index";

const hmacJson = JSON.stringify({
  "1": "11".repeat(32),
  "2": "22".repeat(32),
});
const encJson = JSON.stringify({
  "1": "33".repeat(32),
});

describe("phone crypto", () => {
  it("normalizes Israeli mobile", () => {
    expect(normalizePhone("050-123-4567")).toBe("+972501234567");
  });

  it("uses keyed HMAC and all keyring versions for lookup", () => {
    const ring = parseKeyring(hmacJson);
    const a = lookupCandidates("+972501234567", ring);
    expect(a).toHaveLength(2);
    expect(a[0]?.hash).not.toBe(a[1]?.hash);
    expect(a[0]?.hash).not.toBe("+972501234567");
  });

  it("round-trips encryption with version", () => {
    const cfg = {
      hmacKeyring: parseKeyring(hmacJson),
      encryptionKeyring: parseKeyring(encJson),
      hmacWriteVersion: 1,
      encryptionWriteVersion: 1,
    };
    const sealed = sealPhone("+972501234567", cfg);
    expect(sealed.phoneEncryptionKeyVersion).toBe(1);
    expect(sealed.phoneLookupKeyVersion).toBe(1);
    expect(
      decryptPhone(
        sealed.phoneEncrypted,
        cfg.encryptionKeyring,
        sealed.phoneEncryptionKeyVersion,
      ),
    ).toBe("+972501234567");
  });

  it("redacts phone fields", () => {
    const out = redact({ customerPhone: "+972", nested: { authorization: "Bearer x" } }) as {
      customerPhone: string;
      nested: { authorization: string };
    };
    expect(out.customerPhone).toBe("[redacted]");
    expect(out.nested.authorization).toBe("[redacted]");
  });
});
