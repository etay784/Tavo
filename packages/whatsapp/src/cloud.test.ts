import { describe, expect, it } from "vitest";
import { CloudWhatsAppProvider, TransientSendError, createWhatsAppProvider } from "./index";

describe("Cloud WhatsApp provider", () => {
  it("posts Cloud API text without extra Graph features", async () => {
    const wa = new CloudWhatsAppProvider("token", "v21.0", async (url, init) => {
      expect(String(url)).toContain("graph.facebook.com/v21.0/pn-1/messages");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.messaging_product).toBe("whatsapp");
      expect(body.type).toBe("text");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    });
    const sent = await wa.sendText({ phoneNumberId: "pn-1", toE164: "972501111111", body: "hi" });
    expect(sent.providerMessageId).toBe("wamid.out");
  });

  it("maps 503 to transient", async () => {
    const wa = new CloudWhatsAppProvider("token", "v21.0", async () => new Response("nope", { status: 503 }));
    await expect(
      wa.sendText({ phoneNumberId: "pn-1", toE164: "972501111111", body: "hi" }),
    ).rejects.toBeInstanceOf(TransientSendError);
  });

  it("defaults factory to FakeWhatsApp", () => {
    expect(createWhatsAppProvider({}).constructor.name).toBe("FakeWhatsAppProvider");
  });
});
