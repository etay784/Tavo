import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startEphemeralPostgres, waitForPg, type EphemeralPg } from "./ephemeral-pg";
import { applyMigrations, migrationFiles } from "./migrate";

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
});
