import { describe, expect, it } from "vitest";
import { tenantForApiKey, type AppConfig } from "./config";
import { parseKeyring } from "@tavo/security";

describe("tenantForApiKey", () => {
  const phones = {
    hmacKeyring: parseKeyring(JSON.stringify({ "1": "aa".repeat(32) })),
    encryptionKeyring: parseKeyring(JSON.stringify({ "1": "bb".repeat(32) })),
    hmacWriteVersion: 1,
    encryptionWriteVersion: 1,
  };
  const config: AppConfig = {
    databaseUrl: "postgres://unused",
    apiKeys: new Map([
      ["key-a", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      ["key-b", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
    ]),
    phones,
  };

  it("binds tenant from the secret, not from a caller-supplied id", () => {
    expect(tenantForApiKey(config, "key-a")).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(tenantForApiKey(config, "key-b")).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(tenantForApiKey(config, "missing")).toBeUndefined();
  });
});
