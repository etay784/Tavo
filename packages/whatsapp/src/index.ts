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

export function parseInboundEnvelope(body: unknown): {
  phoneNumberId: string | null;
  events: ParsedInbound[];
} {
  const root = body as {
    object?: string;
    entry?: {
      changes?: {
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }[];
          statuses?: { id?: string }[];
        };
      }[];
    }[];
  };
  const phoneNumberId = root?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
  const value = root?.entry?.[0]?.changes?.[0]?.value;
  if (!value) {
    return { phoneNumberId, events: [{ kind: "unknown", phoneNumberId }] };
  }
  const events: ParsedInbound[] = [];
  for (const m of value.messages ?? []) {
    if (m.type === "text" && m.id && m.from && m.text?.body) {
      const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
      events.push({
        kind: "message_text",
        id: m.id,
        from: m.from,
        timestamp: ts,
        text: m.text.body,
        phoneNumberId: phoneNumberId ?? "",
      });
    } else {
      events.push({ kind: "unknown", phoneNumberId });
    }
  }
  for (const s of value.statuses ?? []) {
    events.push({ kind: "status", id: s.id ?? "unknown", phoneNumberId: phoneNumberId ?? "" });
  }
  if (events.length === 0) {
    events.push({ kind: "unknown", phoneNumberId });
  }
  return { phoneNumberId, events };
}

export type WhatsAppSendResult = { providerMessageId: string };

export interface WhatsAppProvider {
  sendText(input: { phoneNumberId: string; toE164: string; body: string }): Promise<WhatsAppSendResult>;
}

export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly sent: { phoneNumberId: string; toE164: string; body: string }[] = [];
  failMode: "none" | "ambiguous" | "client" = "none";

  async sendText(input: { phoneNumberId: string; toE164: string; body: string }): Promise<WhatsAppSendResult> {
    if (this.failMode === "ambiguous") {
      this.sent.push(input);
      throw new AmbiguousSendError();
    }
    if (this.failMode === "client") {
      throw new ClientSendError("rejected");
    }
    this.sent.push(input);
    return { providerMessageId: `wamid-out-${this.sent.length}` };
  }
}
