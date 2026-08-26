import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startEphemeralPostgres, waitForPg, type EphemeralPg } from "./ephemeral-pg";
import { applyMigrations, migrationFiles, migrationChecksum } from "./migrate";

describe("versioned migrations", () => {
  let pg: EphemeralPg;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
  }, 60_000);

  afterAll(async () => {
    await pg.stop();
  });

  it("upgrades an existing Phase 1 schema exactly once per file", async () => {
    const admin = new Client({ connectionString: pg.superuserUrl });
    await admin.connect();
    try {
      for (const file of migrationFiles()) {
        const name = path.basename(file);
        if (name > "002_schema.sql") continue;
        await admin.query(fs.readFileSync(file, "utf8"));
      }
      const before = await admin.query(
        `SELECT to_regclass('public.appointments') IS NOT NULL AS ok`,
      );
      expect(before.rows[0]?.ok).toBe(true);
      const stampsBefore = await admin.query(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`,
      );
      expect(stampsBefore.rows[0]?.ok).toBe(false);
    } finally {
      await admin.end();
    }

    await applyMigrations(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);

    const check = new Client({ connectionString: pg.superuserUrl });
    await check.connect();
    try {
      const files = migrationFiles().map((f) => path.basename(f));
      const stamps = await check.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations ORDER BY filename`,
      );
      expect(stamps.rows.map((r) => r.filename)).toEqual(files);

      await check.query(
        `INSERT INTO businesses (id, name, timezone)
         VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Upgrade shop', 'Asia/Jerusalem')`,
      );
      const staff = await check.query<{ id: string }>(
        `INSERT INTO staff_members (tenant_id, name)
         VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Ada') RETURNING id`,
      );
      const svc = await check.query<{ id: string }>(
        `INSERT INTO services (tenant_id, name, duration_minutes, price_minor)
         VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Cut', 30, 1) RETURNING id`,
      );
      const cust = await check.query<{ id: string }>(
        `INSERT INTO customers (
           tenant_id, phone_encrypted, phone_encryption_key_version,
           phone_lookup_hash, phone_lookup_key_version
         ) VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'enc', 1, 'h', 1)
         RETURNING id`,
      );
      await check.query(
        `INSERT INTO appointments (
           tenant_id, customer_id, staff_id, service_id,
           start_at, end_at, occupied_start_at, occupied_end_at, status, source
         ) VALUES ($1,$2,$3,$4,
           '2026-08-27 10:00+00','2026-08-27 10:30+00',
           '2026-08-27 10:00+00','2026-08-27 10:30+00','CONFIRMED','INTERNAL')`,
        [
          "dddddddd-dddd-dddd-dddd-dddddddddddd",
          cust.rows[0]!.id,
          staff.rows[0]!.id,
          svc.rows[0]!.id,
        ],
      );
    } finally {
      await check.end();
    }
  });

  it("stores migration checksums and rejects an edited historical file hash", async () => {
    const check = new Client({ connectionString: pg.superuserUrl });
    await check.connect();
    try {
      const rows = await check.query<{ filename: string; checksum: string | null }>(
        `SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.checksum && r.checksum.length === 64)).toBe(true);
      await check.query(`UPDATE schema_migrations SET checksum = $1 WHERE filename = '004_whatsapp_conversations.sql'`, [
        "aa".repeat(32),
      ]);
    } finally {
      await check.end();
    }
    await expect(applyMigrations(pg.superuserUrl)).rejects.toThrow(/checksum mismatch/);
    const restore = new Client({ connectionString: pg.superuserUrl });
    await restore.connect();
    const sql = fs.readFileSync(
      migrationFiles().find((f) => path.basename(f) === "004_whatsapp_conversations.sql")!,
      "utf8",
    );
    await restore.query(`UPDATE schema_migrations SET checksum = $1 WHERE filename = '004_whatsapp_conversations.sql'`, [
      migrationChecksum(sql),
    ]);
    await restore.end();
  });
});

async function schemaFingerprint(url: string): Promise<string> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const cols = await c.query(
      `SELECT table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns WHERE table_schema = 'public'
       ORDER BY 1, 2`,
    );
    const cons = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace
       ORDER BY 1, 2`,
    );
    const enums = await c.query(
      `SELECT t.typname, e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
       ORDER BY 1, e.enumsortorder`,
    );
    const priv = await c.query(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'tavo_app' AND table_schema = 'public'
       ORDER BY 1, 2`,
    );
    const fns = await c.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'tavo_routing'
       ORDER BY 1`,
    );
    return JSON.stringify({
      cols: cols.rows,
      cons: cons.rows,
      enums: enums.rows,
      priv: priv.rows,
      fns: fns.rows,
    });
  } finally {
    await c.end();
  }
}

describe("Phase 2A 004 upgrade equivalence", () => {
  it("fresh apply and original-004-then-later files converge", async () => {
    const fresh = await startEphemeralPostgres();
    const upgraded = await startEphemeralPostgres();
    try {
      await waitForPg(fresh.superuserUrl);
      await waitForPg(upgraded.superuserUrl);
      await applyMigrations(fresh.superuserUrl);

      const admin = new Client({ connectionString: upgraded.superuserUrl });
      await admin.connect();
      try {
        for (const file of migrationFiles()) {
          const name = path.basename(file);
          if (name > "004_whatsapp_conversations.sql") continue;
          await admin.query(fs.readFileSync(file, "utf8"));
        }
        for (const file of migrationFiles()) {
          const name = path.basename(file);
          if (name > "004_whatsapp_conversations.sql") continue;
          await admin.query(
            `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
            [name],
          );
        }
      } finally {
        await admin.end();
      }
      await applyMigrations(upgraded.superuserUrl);
      expect(await schemaFingerprint(fresh.superuserUrl)).toBe(await schemaFingerprint(upgraded.superuserUrl));
    } finally {
      await fresh.stop();
      await upgraded.stop();
    }
  }, 120_000);
});
