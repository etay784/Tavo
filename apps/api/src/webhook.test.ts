import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { parseKeyring } from "@tavo/security";
import {
  applyMigrations,
  startEphemeralPostgres,
  waitForPg,
  withTenant,
  type EphemeralPg,
} from "@tavo/database";
import { buildApp } from "./app";
import type { AppConfig } from "./config";

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const APP_SECRET = "meta-app-secret";
const phones = {
  hmacKeyring: parseKeyring(JSON.stringify({ "1": "aa".repeat(32) })),
  encryptionKeyring: parseKeyring(JSON.stringify({ "1": "bb".repeat(32) })),
  hmacWriteVersion: 1,
  encryptionWriteVersion: 1,
};
const messages = {
  encryptionKeyring: parseKeyring(JSON.stringify({ "1": "cc".repeat(32) })),
  writeVersion: 1,
};

describe("meta webhook http", () => {
  let pg: EphemeralPg;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(`INSERT INTO businesses (id, name, timezone) VALUES ($1,'A','Asia/Jerusalem')`, [TENANT]);
    await admin.query(`INSERT INTO whatsapp_integrations (tenant_id, phone_number_id) VALUES ($1,'pn-a')`, [TENANT]);
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 4 });
    const config: AppConfig = {
      databaseUrl: pg.appUrl,
      apiKeys: new Map([["key-a", TENANT]]),
      phones,
      meta: {
        appSecret: APP_SECRET,
        verifyToken: "verify-me",
        routingHmacKey: Buffer.from("dd".repeat(32), "hex"),
        messages,
      },
    };
    app = buildApp(config, pool, { now: () => new Date("2026-08-25T08:00:00.000Z") });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await pg.stop();
  });

  it("returns challenge on GET verify and 403 on bad token", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("abc");
    const bad = await app.inject({
      method: "GET",
      url: "/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc",
    });
    expect(bad.statusCode).toBe(403);
  });

  it("returns 403 without a valid signature and 200 for signed unknown types", async () => {
    const raw = '{"entry":[]}';
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/meta/whatsapp",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(unsigned.statusCode).toBe(403);
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")}`;
    const signed = await app.inject({
      method: "POST",
      url: "/webhooks/meta/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: raw,
    });
    expect(signed.statusCode).toBe(200);
  });

  it("returns 503 when persistence of a signed executable text event fails", async () => {
    const failing = buildApp(
      {
        databaseUrl: pg.appUrl,
        apiKeys: new Map([["key-a", TENANT]]),
        phones,
        meta: {
          appSecret: APP_SECRET,
          verifyToken: "verify-me",
          routingHmacKey: Buffer.from("dd".repeat(32), "hex"),
          messages,
        },
      },
      pool,
      { now: () => new Date("2026-08-25T08:00:00.000Z") },
      {
        persistWebhook: async () => {
          throw new Error("persist down");
        },
      },
    );
    await failing.ready();
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn-a" },
                messages: [
                  {
                    id: "wamid-persist-fail",
                    from: "972501234567",
                    timestamp: "1780000000",
                    type: "text",
                    text: { body: "שלום" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")}`;
    const res = await failing.inject({
      method: "POST",
      url: "/webhooks/meta/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(503);
    expect(res.statusCode).not.toBe(200);
    await failing.close();
  });

  it("persists every supported message in a signed batch before 200", async () => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn-a" },
                messages: [
                  {
                    id: "wamid-batch-1",
                    from: "972501234567",
                    timestamp: "1780000000",
                    type: "text",
                    text: { body: "אחת" },
                  },
                ],
              },
            },
            {
              value: {
                metadata: { phone_number_id: "pn-a" },
                messages: [
                  {
                    id: "wamid-batch-2",
                    from: "972501234567",
                    timestamp: "1780000001",
                    type: "text",
                    text: { body: "שתיים" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")}`;
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/meta/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const n = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM whatsapp_inbound_events
         WHERE provider_message_id IN ('wamid-batch-1','wamid-batch-2') AND status = 'RECEIVED'`,
      );
      return r.rows[0]!.n;
    });
    expect(n).toBe(2);
  });
});
