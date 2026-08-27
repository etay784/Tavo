import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { startEphemeralPostgres, waitForPg, type EphemeralPg } from "./ephemeral-pg";
import { applyMigrations } from "./migrate";
import { withTenant } from "./tenant";
import {
  claimNextInboundJob,
  insertSystemSecurityEvent,
  resolveWhatsappIntegration,
} from "./routing";
import { insertInboundEvent } from "./phase2";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("SECURITY DEFINER routing", () => {
  let pg: EphemeralPg;
  let appPool: Pool;
  let superClient: Client;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO businesses (id, name, timezone) VALUES ($1,'A','Asia/Jerusalem'), ($2,'B','Asia/Jerusalem')`,
      [TENANT_A, TENANT_B],
    );
    await admin.end();
    appPool = new Pool({ connectionString: pg.appUrl, max: 4 });
    superClient = new Client({ connectionString: pg.superuserUrl });
    await superClient.connect();
    const integA = await superClient.query<{ id: string }>(
      `INSERT INTO whatsapp_integrations (tenant_id, phone_number_id) VALUES ($1,'pn-a') RETURNING id`,
      [TENANT_A],
    );
    await superClient.query(
      `INSERT INTO whatsapp_integrations (tenant_id, phone_number_id) VALUES ($1,'pn-b')`,
      [TENANT_B],
    );
    await withTenant(appPool, TENANT_A, (c) =>
      insertInboundEvent(c, TENANT_A, {
        integrationId: integA.rows[0]!.id,
        providerMessageId: "wamid-a1",
        eventKind: "message_text",
        status: "RECEIVED",
        waTimestamp: new Date("2026-08-27T10:00:00.000Z"),
        payloadSha256: "aa",
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await superClient.end().catch(() => undefined);
    await appPool.end().catch(() => undefined);
    await pg.stop();
  });

  it("does not grant BYPASSRLS to tavo_app", async () => {
    const r = await superClient.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'tavo_app'`,
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("hides tenant queues from tavo_app without tenant context", async () => {
    const c = await appPool.connect();
    try {
      const inbound = await c.query(`SELECT count(*)::int AS n FROM whatsapp_inbound_events`);
      expect(inbound.rows[0].n).toBe(0);
      const conv = await c.query(`SELECT count(*)::int AS n FROM conversations`);
      expect(conv.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("resolve returns only tenant_id and integration_id for a known number", async () => {
    const c = await appPool.connect();
    try {
      const row = await resolveWhatsappIntegration(c, "pn-a");
      expect(row?.tenant_id).toBe(TENANT_A);
      expect(row?.integration_id).toBeTruthy();
      expect(Object.keys(row ?? {}).sort()).toEqual(["integration_id", "tenant_id"]);
      expect(await resolveWhatsappIntegration(c, "pn-unknown")).toBeUndefined();
    } finally {
      c.release();
    }
  });

  it("claim returns only job_id and tenant_id and cannot dump other tenants", async () => {
    const c = await appPool.connect();
    try {
      const claimed = await claimNextInboundJob(c, "worker-1");
      expect(claimed?.tenant_id).toBe(TENANT_A);
      expect(claimed?.job_id).toBeTruthy();
      expect(Object.keys(claimed ?? {}).sort()).toEqual(["job_id", "tenant_id"]);
      const cols = await c.query(`SELECT * FROM tavo_routing.claim_next_inbound_job($1)`, [
        "worker-1",
      ]);
      expect(cols.fields.map((f) => f.name).sort()).toEqual(["job_id", "tenant_id"]);
    } finally {
      c.release();
    }
  });

  it("refuses tavo_app SELECT on system_security_events", async () => {
    const c = await appPool.connect();
    try {
      await expect(c.query(`SELECT event_type FROM system_security_events`)).rejects.toThrow();
    } finally {
      c.release();
    }
  });

  it("insert_system_security_event rejects extra keys and unknown types", async () => {
    const c = await appPool.connect();
    try {
      await expect(
        insertSystemSecurityEvent(c, "webhook.signature_rejected", { body: "nope", reason: "missing" }),
      ).rejects.toThrow();
      await expect(insertSystemSecurityEvent(c, "not.a.type", { reason: "x" })).rejects.toThrow();
      await insertSystemSecurityEvent(c, "webhook.signature_rejected", { reason: "mismatch" });
    } finally {
      c.release();
    }
    const n = await superClient.query(
      `SELECT count(*)::int AS n FROM system_security_events WHERE event_type = 'webhook.signature_rejected'`,
    );
    expect(n.rows[0].n).toBe(1);
    expect(JSON.stringify(n.rows)).not.toMatch(/raw|secret|\+/);
  });

  it("cannot read a claimed job under the wrong tenant", async () => {
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    const integB = await withTenant(appPool, TENANT_B, (c) =>
      c.query<{ id: string }>(`SELECT id FROM whatsapp_integrations`),
    );
    await withTenant(appPool, TENANT_B, (c) =>
      insertInboundEvent(c, TENANT_B, {
        integrationId: integB.rows[0]!.id,
        providerMessageId: "wamid-b1",
        eventKind: "message_text",
        status: "RECEIVED",
        waTimestamp: new Date("2026-08-27T11:00:00.000Z"),
        payloadSha256: "bb",
      }),
    );
    await admin.end();
    const c = await appPool.connect();
    try {
      const claimed = await claimNextInboundJob(c, "worker-2");
      expect(claimed).toBeTruthy();
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [
        claimed!.tenant_id === TENANT_A ? TENANT_B : TENANT_A,
      ]);
      const leak = await c.query(`SELECT id FROM whatsapp_inbound_events WHERE id = $1`, [
        claimed!.job_id,
      ]);
      expect(leak.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("revokes CREATE so tavo_app cannot shadow SECURITY DEFINER resolution", async () => {
    const c = await appPool.connect();
    try {
      await expect(c.query(`CREATE TABLE public.pwn_definer (id int)`)).rejects.toThrow();
      await expect(
        c.query(
          `CREATE FUNCTION public.resolve_whatsapp_integration(text)
           RETURNS TABLE(tenant_id uuid, integration_id uuid) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::uuid $$`,
        ),
      ).rejects.toThrow();
      await expect(c.query(`CREATE SCHEMA pwn_schema`)).rejects.toThrow();
      await expect(
        c.query(`CREATE FUNCTION tavo_routing.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`),
      ).rejects.toThrow();
    } finally {
      c.release();
    }
    const path = await superClient.query<{ search_path: string }>(
      `SELECT pg_get_functiondef(oid) AS search_path
       FROM pg_proc
       WHERE proname = 'resolve_whatsapp_integration'`,
    );
    const def = path.rows[0]?.search_path ?? "";
    expect(def.toLowerCase()).toContain("search_path");
    expect(def).toContain("pg_catalog");
    expect(def).toContain("public.whatsapp_integrations");
  });

  it("upserts a single conversation for concurrent first messages", async () => {
    const cust = await withTenant(appPool, TENANT_A, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, phone_encrypted, phone_encryption_key_version, phone_lookup_hash, phone_lookup_key_version)
         VALUES ($1,'enc',1,'h-race',1) RETURNING id`,
        [TENANT_A],
      );
      return r.rows[0]!.id;
    });
    const { upsertConversation } = await import("./phase2");
    await Promise.all([
      withTenant(appPool, TENANT_A, (c) => upsertConversation(c, TENANT_A, cust)),
      withTenant(appPool, TENANT_A, (c) => upsertConversation(c, TENANT_A, cust)),
    ]);
    const n = await withTenant(appPool, TENANT_A, async (c) => {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversations WHERE customer_id = $1`,
        [cust],
      );
      return r.rows[0]!.n;
    });
    expect(n).toBe(1);
  });

  it("grants tavo_app least privilege on Phase 2 tables", async () => {
    const commands = await superClient.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT
         has_table_privilege('tavo_app', 'public.booking_commands', 'SELECT') AS sel,
         has_table_privilege('tavo_app', 'public.booking_commands', 'INSERT') AS ins,
         has_table_privilege('tavo_app', 'public.booking_commands', 'UPDATE') AS upd,
         has_table_privilege('tavo_app', 'public.booking_commands', 'DELETE') AS del`,
    );
    expect(commands.rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false });
    const messages = await superClient.query<{ upd: boolean; del: boolean }>(
      `SELECT
         has_table_privilege('tavo_app', 'public.messages', 'UPDATE') AS upd,
         has_table_privilege('tavo_app', 'public.messages', 'DELETE') AS del`,
    );
    expect(messages.rows[0]).toEqual({ upd: false, del: false });
    const offered = await superClient.query<{ del: boolean }>(
      `SELECT has_table_privilege('tavo_app', 'public.offered_slots', 'DELETE') AS del`,
    );
    expect(offered.rows[0]?.del).toBe(false);
    const integrations = await superClient.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT
         has_table_privilege('tavo_app', 'public.whatsapp_integrations', 'SELECT') AS sel,
         has_table_privilege('tavo_app', 'public.whatsapp_integrations', 'INSERT') AS ins,
         has_table_privilege('tavo_app', 'public.whatsapp_integrations', 'UPDATE') AS upd,
         has_table_privilege('tavo_app', 'public.whatsapp_integrations', 'DELETE') AS del`,
    );
    expect(integrations.rows[0]).toEqual({ sel: true, ins: false, upd: false, del: false });
    const exceptions = await superClient.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT
         has_table_privilege('tavo_app', 'public.staff_schedule_exceptions', 'SELECT') AS sel,
         has_table_privilege('tavo_app', 'public.staff_schedule_exceptions', 'INSERT') AS ins,
         has_table_privilege('tavo_app', 'public.staff_schedule_exceptions', 'UPDATE') AS upd,
         has_table_privilege('tavo_app', 'public.staff_schedule_exceptions', 'DELETE') AS del`,
    );
    expect(exceptions.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: true });
    const routing = await superClient.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT
         has_table_privilege('tavo_app', 'public.conversation_routing', 'SELECT') AS sel,
         has_table_privilege('tavo_app', 'public.conversation_routing', 'INSERT') AS ins,
         has_table_privilege('tavo_app', 'public.conversation_routing', 'UPDATE') AS upd,
         has_table_privilege('tavo_app', 'public.conversation_routing', 'DELETE') AS del`,
    );
    expect(routing.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: false });
  });

  it("isolates conversation_routing by tenant", async () => {
    const conv = await withTenant(appPool, TENANT_A, async (c) => {
      const cust = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, phone_encrypted, phone_encryption_key_version, phone_lookup_hash, phone_lookup_key_version)
         VALUES ($1,'enc',1,'h-route',1) RETURNING id`,
        [TENANT_A],
      );
      const { upsertConversation, getOrCreateConversationRouting } = await import("./phase2");
      const conversation = await upsertConversation(c, TENANT_A, cust.rows[0]!.id);
      await getOrCreateConversationRouting(c, TENANT_A, conversation.id, cust.rows[0]!.id);
      return conversation.id;
    });
    const hidden = await withTenant(appPool, TENANT_B, async (c) => {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversation_routing WHERE conversation_id = $1`,
        [conv],
      );
      return r.rows[0]!.n;
    });
    expect(hidden).toBe(0);
    const visible = await withTenant(appPool, TENANT_A, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversation_routing`);
      return r.rows[0]!.n;
    });
    expect(visible).toBeGreaterThan(0);
  });
});
