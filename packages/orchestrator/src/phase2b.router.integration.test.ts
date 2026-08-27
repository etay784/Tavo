import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { applyMigrations, seedTavoDemoBarbers, startEphemeralPostgres, waitForPg, withTenant, type EphemeralPg } from "@tavo/database";
import { parseKeyring } from "@tavo/security";
import { AppointmentService, SchedulingService } from "@tavo/domain";
import { FakeAIProvider } from "@tavo/ai";
import { FakeWhatsAppProvider } from "@tavo/whatsapp";
import { InboundProcessor, persistParsedWebhook, runInboundOnce, runOutboundOnce } from "./index";

const TENANT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const hmac = { "1": "aa".repeat(32) };
const enc = { "1": "bb".repeat(32) };
const msg = { "1": "cc".repeat(32) };
const phoneKeys = {
  hmacKeyring: parseKeyring(JSON.stringify(hmac)),
  encryptionKeyring: parseKeyring(JSON.stringify(enc)),
  hmacWriteVersion: 1,
  encryptionWriteVersion: 1,
};
const messages = { encryptionKeyring: parseKeyring(JSON.stringify(msg)), writeVersion: 1 };
const routingKey = Buffer.from("dd".repeat(32), "hex");

function textPayload(wamid: string, body: string, from: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn-demo" },
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: "1780000000",
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("Phase 2B Silent Router integration", () => {
  let pg: EphemeralPg;
  let pool: Pool;
  let processor: InboundProcessor;
  let fakeWa: FakeWhatsAppProvider;
  const clock = { now: () => new Date("2026-08-25T08:00:00.000Z") };

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await seedTavoDemoBarbers(admin as never, { tenantId: TENANT, phoneNumberId: "pn-demo" });
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 8 });
    const scheduling = new SchedulingService(pool, clock);
    const appointments = new AppointmentService(pool, scheduling, phoneKeys);
    processor = new InboundProcessor(
      pool,
      clock,
      phoneKeys,
      messages,
      scheduling,
      appointments,
      new FakeAIProvider(),
    );
    fakeWa = new FakeWhatsAppProvider();
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await pg.stop();
  });

  async function inbound(wamid: string, body: string, from: string) {
    const raw = JSON.stringify(textPayload(wamid, body, from));
    await persistParsedWebhook(pool, Buffer.from(raw), JSON.parse(raw), messages, routingKey);
    await runInboundOnce(pool, "w-2b", processor);
    await runOutboundOnce(pool, "w-2b", phoneKeys, messages, fakeWa);
  }

  it("silences UNKNOWN personal traps and does not consume LLM budget", async () => {
    const from = "972500200001";
    const before = fakeWa.sent.length;
    await inbound("wamid-trap-1", "תוריד את הסרטון", from);
    await inbound("wamid-trap-2", "מחר?", from);
    expect(fakeWa.sent.length).toBe(before);
    const rows = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ status: string; provider_message_id: string }>(
        `SELECT status, provider_message_id FROM whatsapp_inbound_events
         WHERE provider_message_id IN ('wamid-trap-1','wamid-trap-2')`,
      );
      return r.rows;
    });
    expect(rows.every((r) => r.status === "PROCESSED")).toBe(true);
    const budget = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM llm_budget_windows`);
      return r.rows[0]!.n;
    });
    expect(budget).toBe(0);
    const state = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ routing_state: string }>(`SELECT routing_state FROM conversation_routing LIMIT 1`);
      return r.rows[0]?.routing_state;
    });
    expect(state).toBe("UNKNOWN");
  });

  it("allows a Tier-B combination without persisting BUSINESS_VERIFIED", async () => {
    const from = "972500200002";
    await inbound("wamid-tierb", "יש תור מחר?", from);
    expect(fakeWa.sent[fakeWa.sent.length - 1]?.body).toMatch(/זמין:|איזה שירות/);
    const state = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ routing_state: string }>(
        `SELECT cr.routing_state
         FROM conversation_routing cr
         JOIN whatsapp_inbound_events e ON e.conversation_id = cr.conversation_id
         WHERE e.provider_message_id = 'wamid-tierb'`,
      );
      return r.rows[0]?.routing_state;
    });
    expect(state).toBe("UNKNOWN");
  });

  it("honors owner PERSONAL override even on a booking phrase", async () => {
    const from = "972500200003";
    await inbound("wamid-owner-pre", "יש תור מחר?", from);
    await withTenant(pool, TENANT, async (c) => {
      const ids = await c.query<{ conversation_id: string; customer_id: string }>(
        `SELECT e.conversation_id, conv.customer_id
         FROM whatsapp_inbound_events e
         JOIN conversations conv ON conv.tenant_id = e.tenant_id AND conv.id = e.conversation_id
         WHERE e.provider_message_id = 'wamid-owner-pre'`,
      );
      const { setOwnerConversationRouting } = await import("@tavo/database");
      await setOwnerConversationRouting(
        c,
        TENANT,
        ids.rows[0]!.conversation_id,
        ids.rows[0]!.customer_id,
        "PERSONAL_EXCLUDED",
      );
    });
    const before = fakeWa.sent.length;
    await inbound("wamid-owner-block", "תספורת מחר בערב", from);
    expect(fakeWa.sent.length).toBe(before);
  });
});