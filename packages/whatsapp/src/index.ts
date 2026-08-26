import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

export class AmbiguousSendError extends Error {
  readonly kind = "AMBIGUOUS" as const;
  constructor(message = "send outcome unknown") {
    super(message);
    this.name = "AmbiguousSendError";
  }
}

export class ClientSendError extends Error {
  readonly kind = "CLIENT" as const;
  constructor(message: string) {
    super(message);
    this.name = "ClientSendError";
  }
}

export class TransientSendError extends Error {
  readonly kind = "TRANSIENT" as const;
  constructor(message: string) {
    super(message);
    this.name = "TransientSendError";
  }
}

export type ParsedInboundMessage = {
  kind: "message_text";
  id: string;
  from: string;
  timestamp: Date;
  text: string;
  phoneNumberId: string;
};

export type ParsedInboundStatus = {
  kind: "status";
  id: string;
  phoneNumberId: string;
};

export type ParsedInboundUnknown = {
  kind: "unknown";
  phoneNumberId: string | null;
};

export type ParsedInbound = ParsedInboundMessage | ParsedInboundStatus | ParsedInboundUnknown;

export type ParseEnvelopeResult =
  | { ok: true; events: ParsedInbound[] }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const presented = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifySubscription(
  query: { mode?: string; token?: string; challenge?: string },
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  if (query.mode === "subscribe" && query.token === verifyToken && query.challenge) {
    return { ok: true, challenge: query.challenge };
  }
  return { ok: false };
}

export function payloadSha256(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function parseInboundEnvelope(body: unknown): ParseEnvelopeResult {
  if (!isRecord(body)) {
    return { ok: false, reason: "not_object" };
  }
  if (body.object !== undefined && body.object !== "whatsapp_business_account") {
    return { ok: false, reason: "unsupported_object" };
  }
  if (body.entry === undefined) {
    return { ok: false, reason: "missing_entry" };
  }
  if (!Array.isArray(body.entry)) {
    return { ok: false, reason: "entry_not_array" };
  }
  const events: ParsedInbound[] = [];
  for (const entry of body.entry) {
    if (!isRecord(entry)) {
      return { ok: false, reason: "entry_item" };
    }
    if (entry.changes === undefined) continue;
    if (!Array.isArray(entry.changes)) {
      return { ok: false, reason: "changes_not_array" };
    }
    for (const change of entry.changes) {
      if (!isRecord(change)) {
        return { ok: false, reason: "change_item" };
      }
      const value = change.value;
      if (value === undefined) continue;
      if (!isRecord(value)) {
        return { ok: false, reason: "value_not_object" };
      }
      const metadata = value.metadata;
      const phoneNumberId = isRecord(metadata) ? (asString(metadata.phone_number_id) ?? null) : null;
      let produced = false;
      if (value.messages !== undefined) {
        if (!Array.isArray(value.messages)) {
          return { ok: false, reason: "messages_not_array" };
        }
        for (const m of value.messages) {
          if (!isRecord(m)) {
            return { ok: false, reason: "message_item" };
          }
          produced = true;
          const id = asString(m.id);
          const from = asString(m.from);
          const type = asString(m.type);
          const textObj = m.text;
          const textBody = isRecord(textObj) && typeof textObj.body === "string" ? textObj.body : undefined;
          if (type === "text" && id && from && textBody !== undefined && phoneNumberId) {
            const tsRaw = asString(m.timestamp);
            const ts = tsRaw ? new Date(Number(tsRaw) * 1000) : new Date();
            events.push({
              kind: "message_text",
              id,
              from,
              timestamp: ts,
              text: textBody,
              phoneNumberId,
            });
          } else {
            events.push({ kind: "unknown", phoneNumberId });
          }
        }
      }
      if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses)) {
          return { ok: false, reason: "statuses_not_array" };
        }
        for (const s of value.statuses) {
          if (!isRecord(s)) {
            return { ok: false, reason: "status_item" };
          }
          produced = true;
          events.push({
            kind: "status",
            id: asString(s.id) ?? "unknown",
            phoneNumberId: phoneNumberId ?? "",
          });
        }
      }
      if (!produced) {
        events.push({ kind: "unknown", phoneNumberId });
      }
    }
  }
  if (events.length === 0) {
    events.push({ kind: "unknown", phoneNumberId: null });
  }
  return { ok: true, events };
}

export type WhatsAppSendResult = { providerMessageId: string };

export interface WhatsAppProvider {
  sendText(
    input: { phoneNumberId: string; toE164: string; body: string },
    signal?: AbortSignal,
  ): Promise<WhatsAppSendResult>;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TransientSendError("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TransientSendError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly sent: { phoneNumberId: string; toE164: string; body: string }[] = [];
  failMode: "none" | "ambiguous" | "client" | "transient" = "none";
  delayMs = 0;

  async sendText(
    input: { phoneNumberId: string; toE164: string; body: string },
    signal?: AbortSignal,
  ): Promise<WhatsAppSendResult> {
    await wait(this.delayMs, signal);
    if (this.failMode === "ambiguous") {
      this.sent.push(input);
      throw new AmbiguousSendError();
    }
    if (this.failMode === "client") {
      throw new ClientSendError("rejected");
    }
    if (this.failMode === "transient") {
      throw new TransientSendError("timeout");
    }
    this.sent.push(input);
    return { providerMessageId: `wamid-out-${this.sent.length}` };
  }
}
