import { describe, expect, it } from "vitest";
import { createWhatsAppProvider } from "@tavo/whatsapp";

describe.skipIf(process.env.TAVO_META_E2E !== "1")("Meta test-number E2E", () => {
  it("sends one Cloud API text to the configured test recipient", async () => {
    const token = process.env.TAVO_META_ACCESS_TOKEN;
    const phoneNumberId = process.env.TAVO_META_PHONE_NUMBER_ID;
    const to = process.env.TAVO_META_TEST_TO;
    expect(token && phoneNumberId && to, "Meta E2E secrets missing").toBeTruthy();
    const provider = createWhatsAppProvider({
      TAVO_WHATSAPP_PROVIDER: "cloud",
      TAVO_META_ACCESS_TOKEN: token,
      TAVO_META_GRAPH_VERSION: process.env.TAVO_META_GRAPH_VERSION,
    });
    const result = await provider.sendText({
      phoneNumberId: phoneNumberId!,
      toE164: to!,
      body: "Tavo Phase 2B test-number ping",
    });
    expect(result.providerMessageId.length).toBeGreaterThan(3);
  });
});
