import { createHash, timingSafeEqual } from "node:crypto";
import { parseKeyring, type PhoneCryptoConfig } from "@tavo/security";

export type AppConfig = {
  databaseUrl: string;
  apiKeys: Map<string, string>;
  phones: PhoneCryptoConfig;
  meta: {
    appSecret: string;
    verifyToken: string;
    routingHmacKey: Buffer;
    messages: { encryptionKeyring: import("@tavo/security").Keyring; writeVersion: number };
  };
};

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function requireHex32(env: NodeJS.ProcessEnv, name: string): Buffer {
  const v = requireEnv(env, name);
  if (!/^[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${name} must be 32-byte hex`);
  }
  return Buffer.from(v, "hex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const keysRaw = JSON.parse(requireEnv(env, "TAVO_API_KEYS")) as Record<string, string>;
  const apiKeys = new Map(Object.entries(keysRaw));
  if (apiKeys.size === 0) throw new Error("TAVO_API_KEYS empty");
  const hmacKeyring = parseKeyring(requireEnv(env, "TAVO_PHONE_HMAC_KEYS"));
  const encryptionKeyring = parseKeyring(requireEnv(env, "TAVO_PHONE_ENCRYPTION_KEYS"));
  const hmacWriteVersion = Number(requireEnv(env, "TAVO_PHONE_HMAC_WRITE_VERSION"));
  const encryptionWriteVersion = Number(requireEnv(env, "TAVO_PHONE_ENCRYPTION_WRITE_VERSION"));
  if (!hmacKeyring.has(hmacWriteVersion) || !encryptionKeyring.has(encryptionWriteVersion)) {
    throw new Error("write key version not in keyring");
  }
  const messageKeyring = parseKeyring(requireEnv(env, "TAVO_MESSAGE_ENCRYPTION_KEYS"));
  const messageWriteVersion = Number(requireEnv(env, "TAVO_MESSAGE_ENCRYPTION_WRITE_VERSION"));
  if (!messageKeyring.has(messageWriteVersion)) {
    throw new Error("message write key version not in keyring");
  }
  const appSecret = requireEnv(env, "TAVO_META_APP_SECRET");
  const verifyToken = requireEnv(env, "TAVO_META_VERIFY_TOKEN");
  if (appSecret.length < 8 || verifyToken.length < 8) {
    throw new Error("Meta app secret and verify token are required");
  }
  return {
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    apiKeys,
    phones: {
      hmacKeyring,
      encryptionKeyring,
      hmacWriteVersion,
      encryptionWriteVersion,
    },
    meta: {
      appSecret,
      verifyToken,
      routingHmacKey: requireHex32(env, "TAVO_ROUTING_HMAC_KEY"),
      messages: { encryptionKeyring: messageKeyring, writeVersion: messageWriteVersion },
    },
  };
}

export function tenantForApiKey(config: AppConfig, apiKey: string): string | undefined {
  const presented = createHash("sha256").update(apiKey, "utf8").digest();
  let found: string | undefined;
  for (const [secret, tenantId] of config.apiKeys) {
    const expected = createHash("sha256").update(secret, "utf8").digest();
    if (timingSafeEqual(presented, expected)) {
      found = tenantId;
    }
  }
  return found;
}
