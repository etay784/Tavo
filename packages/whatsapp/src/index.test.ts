import { describe, expect, it } from "vitest";
import { parseInboundEnvelope, verifyMetaSignature, verifySubscription } from "./index";
import { createHmac } from "node:crypto";

describe("meta webhook crypto", () => {
  it("accepts a valid HMAC over the raw body", () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}', "utf8");
    const secret = "app-secret";
    const header = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, header, secret)).toBe(true);
    expect(verifyMetaSignature(raw, header, "other")).toBe(false);
    expect(verifyMetaSignature(Buffer.from("{}", "utf8"), header, secret)).toBe(false);
  });

  it("verifies subscription tokens", () => {
    expect(verifySubscription({ mode: "subscribe", token: "t", challenge: "c" }, "t")).toEqual({
      ok: true,
      challenge: "c",
    });
    expect(verifySubscription({ mode: "subscribe", token: "nope", challenge: "c" }, "t")).toEqual({
      ok: false,
    });
  });

  it("parses every entry and change with its own phone_number_id", () => {
    const parsed = parseInboundEnvelope({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn-a" },
                messages: [
                  {
                    id: "wamid.1",
                    from: "972501234567",
                    timestamp: "1780000000",
                    type: "text",
                    text: { body: "שלום" },
                  },
                ],
              },
            },
            {
              value: {
                metadata: { phone_number_id: "pn-b" },
                messages: [
                  {
                    id: "wamid.2",
                    from: "972509999999",
                    timestamp: "1780000001",
                    type: "text",
                    text: { body: "היי" },
                  },
                ],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn-a" },
                statuses: [{ id: "wamid.status" }],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]).toMatchObject({ kind: "message_text", id: "wamid.1", phoneNumberId: "pn-a" });
    expect(parsed.events[1]).toMatchObject({ kind: "message_text", id: "wamid.2", phoneNumberId: "pn-b" });
    expect(parsed.events[2]).toMatchObject({ kind: "status", id: "wamid.status", phoneNumberId: "pn-a" });
  });

  it("rejects unsupported envelope shapes at runtime", () => {
    expect(parseInboundEnvelope("nope").ok).toBe(false);
    expect(parseInboundEnvelope({ object: "instagram", entry: [] }).ok).toBe(false);
    expect(parseInboundEnvelope({ entry: { changes: [] } }).ok).toBe(false);
  });
});
