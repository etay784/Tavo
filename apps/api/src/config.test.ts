import { describe, expect, it } from "vitest";
import { loadConfig, tenantForApiKey, type AppConfig } from "./config";
import { parseKeyring } from "@tavo/security";

const hex = "aa".repeat(32);
const envBase: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://tavo_app@127.0.0.1:5432/tavo",
  TAVO_API_KEYS: JSON.stringify({ "key-a": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
  TAVO_PHONE_HMAC_KEYS: JSON.stringify({ "1": hex }),
  TAVO_PHONE_ENCRYPTION_KEYS: JSON.stringify({ "1": "bb".repeat(32) }),
  TAVO_PHONE_HMAC_WRITE_VERSION: "1",
  TAVO_PHONE_ENCRYPTION_WRITE_VERSION: "1",
  TAVO_MESSAGE_ENCRYPTION_KEYS: JSON.stringify({ "1": "cc".repeat(32) }),
  TAVO_MESSAGE_ENCRYPTION_WRITE_VERSION: "1",
  TAVO_META_APP_SECRET: "meta-secret-value",
  TAVO_META_VERIFY_TOKEN: "verify-token-value",
  TAVO_ROUTING_HMAC_KEY: "dd".repeat(32),
};

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
    meta: {
      appSecret: "s",
      verifyToken: "t",
      routingHmacKey: Buffer.from("dd".repeat(32), "hex"),
      messages: { encryptionKeyring: parseKeyring(JSON.stringify({ "1": "cc".repeat(32) })), writeVersion: 1 },
    },
  };

  it("binds tenant from the secret, not from a caller-supplied id", () => {
    expect(tenantForApiKey(config, "key-a")).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(tenantForApiKey(config, "key-b")).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(tenantForApiKey(config, "missing")).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("loads Meta, routing HMAC, and a distinct message keyring", () => {
    const cfg = loadConfig(envBase);
    expect(cfg.meta.appSecret).toBe("meta-secret-value");
    expect(cfg.meta.verifyToken).toBe("verify-token-value");
    expect(cfg.meta.routingHmacKey.equals(Buffer.from("dd".repeat(32), "hex"))).toBe(true);
    expect(cfg.meta.messages.writeVersion).toBe(1);
    expect(cfg.meta.messages.encryptionKeyring.get(1)?.equals(Buffer.from("cc".repeat(32), "hex"))).toBe(
      true,
    );
    expect(cfg.phones.encryptionKeyring.get(1)?.equals(Buffer.from("bb".repeat(32), "hex"))).toBe(true);
  });

  it("rejects missing message keys and invalid routing HMAC", () => {
    const noMsg = { ...envBase };
    delete noMsg.TAVO_MESSAGE_ENCRYPTION_KEYS;
    expect(() => loadConfig(noMsg)).toThrow(/TAVO_MESSAGE_ENCRYPTION_KEYS/);
    expect(() => loadConfig({ ...envBase, TAVO_ROUTING_HMAC_KEY: "short" })).toThrow(/32-byte hex/);
    const noMeta = { ...envBase };
    delete noMeta.TAVO_META_APP_SECRET;
    expect(() => loadConfig(noMeta)).toThrow(/TAVO_META_APP_SECRET/);
  });
});
