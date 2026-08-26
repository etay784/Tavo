import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const E164 = /^\+[1-9]\d{7,14}$/;

export type Keyring = Map<number, Buffer>;

export function parseKeyring(json: string): Keyring {
  const raw = JSON.parse(json) as Record<string, string>;
  const map: Keyring = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const version = Number(k);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("invalid key version");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error("phone keys must be 32-byte hex");
    }
    map.set(version, Buffer.from(v, "hex"));
  }
  if (map.size === 0) {
    throw new Error("empty keyring");
  }
  return map;
}

/** Israeli local 05X-XXX-XXXX → +9725X... ; otherwise require E.164. */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digitsOrPlus = trimmed.replace(/[\s()-]/g, "");
  if (E164.test(digitsOrPlus)) {
    return digitsOrPlus;
  }
  if (/^0[5]\d{8}$/.test(digitsOrPlus)) {
    return `+972${digitsOrPlus.slice(1)}`;
  }
  if (/^9725\d{8}$/.test(digitsOrPlus) || /^[1-9]\d{7,14}$/.test(digitsOrPlus)) {
    return `+${digitsOrPlus}`;
  }
  throw new Error("phone must be E.164 or Israeli mobile 05XXXXXXXX");
}

export function hmacPhone(
  normalized: string,
  key: Buffer,
  version: number,
): { hash: string; version: number } {
  const hash = createHmac("sha256", key).update(normalized, "utf8").digest("hex");
  return { hash, version };
}

export function lookupCandidates(
  normalized: string,
  hmacKeyring: Keyring,
): { hash: string; version: number }[] {
  const out: { hash: string; version: number }[] = [];
  for (const [version, key] of hmacKeyring) {
    out.push(hmacPhone(normalized, key, version));
  }
  return out;
}

export function encryptPhone(
  plaintextNormalized: string,
  key: Buffer,
  version: number,
): { ciphertext: string; version: number } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintextNormalized, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return { ciphertext: packed, version };
}

export function encryptUtf8(
  plaintext: string,
  key: Buffer,
  version: number,
): { ciphertext: string; version: number } {
  return encryptPhone(plaintext, key, version);
}

export function decryptPhone(
  ciphertext: string,
  encryptionKeyring: Keyring,
  version: number,
): string {
  const key = encryptionKeyring.get(version);
  if (!key) {
    throw new Error(`missing encryption key version ${version}`);
  }
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 28) {
    throw new Error("invalid ciphertext");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function decryptUtf8(
  ciphertext: string,
  encryptionKeyring: Keyring,
  version: number,
): string {
  return decryptPhone(ciphertext, encryptionKeyring, version);
}

export type PhoneCryptoConfig = {
  hmacKeyring: Keyring;
  encryptionKeyring: Keyring;
  hmacWriteVersion: number;
  encryptionWriteVersion: number;
};

export function sealPhone(normalized: string, cfg: PhoneCryptoConfig) {
  const hmacKey = cfg.hmacKeyring.get(cfg.hmacWriteVersion);
  const encKey = cfg.encryptionKeyring.get(cfg.encryptionWriteVersion);
  if (!hmacKey || !encKey) {
    throw new Error("write key version missing from keyring");
  }
  const lookup = hmacPhone(normalized, hmacKey, cfg.hmacWriteVersion);
  const enc = encryptPhone(normalized, encKey, cfg.encryptionWriteVersion);
  return {
    phoneLookupHash: lookup.hash,
    phoneLookupKeyVersion: lookup.version,
    phoneEncrypted: enc.ciphertext,
    phoneEncryptionKeyVersion: enc.version,
  };
}

const REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "phone",
  "customerphone",
  "phone_encrypted",
  "phoneencrypted",
  "password",
  "secret",
  "apikey",
  "api_key",
  "token",
]);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (REDACT_KEYS.has(k.toLowerCase()) || REDACT_KEYS.has(key)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export function createLogger(level: "debug" | "info" | "warn" | "error" = "info") {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  return {
    info(obj: Record<string, unknown>, msg: string) {
      if (order[level] <= 20) {
        process.stdout.write(
          JSON.stringify({ level: "info", msg, ...((redact(obj) as object) ?? {}) }) +
            "\n",
        );
      }
    },
    error(obj: Record<string, unknown>, msg: string) {
      process.stderr.write(
        JSON.stringify({ level: "error", msg, ...((redact(obj) as object) ?? {}) }) +
          "\n",
      );
    },
  };
}
