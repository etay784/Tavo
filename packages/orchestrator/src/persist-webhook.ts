import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import {
  insertInboundEvent,
  insertSystemSecurityEvent,
  resolveWhatsappIntegration,
  withTenant,
} from "@tavo/database";
import { encryptUtf8 } from "@tavo/security";
import { parseInboundEnvelope, payloadSha256, type ParsedInbound } from "@tavo/whatsapp";
import type { MessageCrypto } from "./inbound-processor";

function hmacId(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export async function persistParsedWebhook(
  pool: Pool,
  raw: Buffer,
  json: unknown,
  messages: MessageCrypto,
  routingHmacKey: Buffer,
): Promise<{ accepted: number; duplicates: number }> {
  const parsed = parseInboundEnvelope(json);
  const sha = payloadSha256(raw);
  if (!parsed.phoneNumberId) {
    const c = await pool.connect();
    try {
      await insertSystemSecurityEvent(c, "webhook.malformed_envelope", { schema: "missing_phone_number_id" });
    } finally {
      c.release();
    }
    return { accepted: 0, duplicates: 0 };
  }
  const c = await pool.connect();
  let resolved: { tenant_id: string; integration_id: string } | undefined;
  try {
    resolved = await resolveWhatsappIntegration(c, parsed.phoneNumberId);
    if (!resolved) {
      await insertSystemSecurityEvent(c, "webhook.unknown_phone_number_id", {
        phone_number_id_hmac: hmacId(parsed.phoneNumberId, routingHmacKey),
      });
      return { accepted: 0, duplicates: 0 };
    }
  } finally {
    c.release();
  }
  let accepted = 0;
  let duplicates = 0;
  for (const event of parsed.events) {
    const result = await persistOne(pool, resolved, sha, event, messages);
    if (result === "dup") duplicates += 1;
    else if (result === "ok") accepted += 1;
  }
  return { accepted, duplicates };
}

async function persistOne(
  pool: Pool,
  resolved: { tenant_id: string; integration_id: string },
  sha: string,
  event: ParsedInbound,
  messages: MessageCrypto,
): Promise<"ok" | "dup" | "skip"> {
  const key = messages.encryptionKeyring.get(messages.writeVersion);
  if (!key) throw new Error("message key");
  try {
    await withTenant(pool, resolved.tenant_id, async (client) => {
      if (event.kind === "message_text") {
        const sender = encryptUtf8(event.from, key, messages.writeVersion);
        const text = encryptUtf8(event.text, key, messages.writeVersion);
        await insertInboundEvent(client, resolved.tenant_id, {
          integrationId: resolved.integration_id,
          providerMessageId: event.id,
          eventKind: "message_text",
          status: "RECEIVED",
          waTimestamp: event.timestamp,
          payloadSha256: sha,
          senderEncrypted: sender.ciphertext,
          senderEncryptionKeyVersion: sender.version,
          textEncrypted: text.ciphertext,
          textEncryptionKeyVersion: text.version,
        });
        return;
      }
      await insertInboundEvent(client, resolved.tenant_id, {
        integrationId: resolved.integration_id,
        providerMessageId:
          event.kind === "status" ? event.id : `unknown:${sha}`,
        eventKind: event.kind === "status" ? "status" : "unknown",
        status: "IGNORED",
        waTimestamp: null,
        payloadSha256: sha,
      });
    });
    return "ok";
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "23505") return "dup";
    throw e;
  }
}
