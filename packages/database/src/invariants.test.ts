import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { startEphemeralPostgres, waitForPg, type EphemeralPg } from "./ephemeral-pg";
import { bootstrapRolesAndSchema } from "./migrate";
import { withTenant } from "./tenant";
import { Errors } from "@tavo/shared";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let pg: EphemeralPg;
let appPool: Pool;
let superClient: Client;

async function seedTenants(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO businesses (id, name, timezone) VALUES ($1,'Shop A','Asia/Jerusalem'), ($2,'Shop B','Asia/Jerusalem')`,
      [TENANT_A, TENANT_B],
    );
    const staffA = await c.query(
      `INSERT INTO staff_members (tenant_id, name) VALUES ($1,'Daniel') RETURNING id`,
      [TENANT_A],
    );
    const staffB = await c.query(
      `INSERT INTO staff_members (tenant_id, name) VALUES ($1,'Itay') RETURNING id`,
      [TENANT_B],
    );
    const svcA = await c.query(
      `INSERT INTO services (tenant_id, name, duration_minutes, price_minor, buffer_after_minutes)
       VALUES ($1,'Haircut',30,9000,5) RETURNING id`,
      [TENANT_A],
    );
    const svcB = await c.query(
      `INSERT INTO services (tenant_id, name, duration_minutes, price_minor)
       VALUES ($1,'Haircut',30,9000) RETURNING id`,
      [TENANT_B],
    );
    const locB = await c.query(
      `INSERT INTO locations (tenant_id, name) VALUES ($1,'B loc') RETURNING id`,
      [TENANT_B],
    );
    const custA = await c.query(
      `INSERT INTO customers (tenant_id, phone_encrypted, phone_encryption_key_version, phone_lookup_hash, phone_lookup_key_version)
       VALUES ($1,'enc',1,'hash-a',1) RETURNING id`,
      [TENANT_A],
    );
    const custB = await c.query(
      `INSERT INTO customers (tenant_id, phone_encrypted, phone_encryption_key_version, phone_lookup_hash, phone_lookup_key_version)
       VALUES ($1,'enc',1,'hash-b',1) RETURNING id`,
      [TENANT_B],
    );
    return {
      staffA: staffA.rows[0].id as string,
      staffB: staffB.rows[0].id as string,
      svcA: svcA.rows[0].id as string,
      svcB: svcB.rows[0].id as string,
      locB: locB.rows[0].id as string,
      custA: custA.rows[0].id as string,
      custB: custB.rows[0].id as string,
    };
  } finally {
    await c.end();
  }
}

let ids: Awaited<ReturnType<typeof seedTenants>>;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await waitForPg(pg.superuserUrl);
  await bootstrapRolesAndSchema(pg.superuserUrl);
  ids = await seedTenants(pg.migratorUrl);
  appPool = new Pool({ connectionString: pg.appUrl, max: 4 });
  superClient = new Client({ connectionString: pg.superuserUrl });
  await superClient.connect();
}, 60_000);

afterAll(async () => {
  await superClient.end().catch(() => undefined);
  await appPool.end().catch(() => undefined);
  await pg.stop();
});

describe("roles and FORCE RLS", () => {
  it("tavo_app is not owner, has no BYPASSRLS, tables force RLS", async () => {
    const bypass = await superClient.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'tavo_app'`,
    );
    expect(bypass.rows[0].rolbypassrls).toBe(false);
    const migratorBypass = await superClient.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'tavo_migrator'`,
    );
    expect(migratorBypass.rows[0].rolbypassrls).toBe(true);
    const tables = await superClient.query<{ relname: string; owner: string; force: boolean; rls: boolean }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relforcerowsecurity AS force, c.relrowsecurity AS rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    for (const row of tables.rows) {
      expect(row.owner).toBe("tavo_migrator");
      expect(row.owner).not.toBe("tavo_app");
      if (row.relname === "schema_migrations") {
        expect(row.rls).toBe(false);
        continue;
      }
      expect(row.rls).toBe(true);
      expect(row.force).toBe(true);
    }
  });
});

describe("RLS", () => {
  it("without tenant setting, app sees no staff", async () => {
    const c = await appPool.connect();
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM staff_members`);
      expect(r.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("does not leak tenant across concurrent pooled connections", async () => {
    const [a, b] = await Promise.all([
      withTenant(appPool, TENANT_A, async (c) => {
        const r = await c.query(`SELECT name FROM staff_members`);
        return r.rows.map((x) => x.name);
      }),
      withTenant(appPool, TENANT_B, async (c) => {
        const r = await c.query(`SELECT name FROM staff_members`);
        return r.rows.map((x) => x.name);
      }),
    ]);
    expect(a).toEqual(["Daniel"]);
    expect(b).toEqual(["Itay"]);
  });

  it("does not leak tenant across pooled sequential transactions", async () => {
    const pool = new Pool({ connectionString: pg.appUrl, max: 1 });
    try {
      const a = await withTenant(pool, TENANT_A, async (c) => {
        const r = await c.query(`SELECT name FROM staff_members`);
        return r.rows.map((x) => x.name);
      });
      const b = await withTenant(pool, TENANT_B, async (c) => {
        const r = await c.query(`SELECT name FROM staff_members`);
        return r.rows.map((x) => x.name);
      });
      expect(a).toEqual(["Daniel"]);
      expect(b).toEqual(["Itay"]);
    } finally {
      await pool.end();
    }
  });
});

describe("composite FKs", () => {
  it("rejects Tenant A appointment using Tenant B staff_id", async () => {
    await expect(
      withTenant(appPool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO appointments (
             tenant_id, customer_id, staff_id, service_id,
             start_at, end_at, occupied_start_at, occupied_end_at, status, source
           ) VALUES ($1,$2,$3,$4,
             '2026-08-27 17:00+00','2026-08-27 17:30+00',
             '2026-08-27 17:00+00','2026-08-27 17:35+00','CONFIRMED','INTERNAL')`,
          [TENANT_A, ids.custA, ids.staffB, ids.svcA],
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects Tenant A using Tenant B service_id, customer_id, location_id", async () => {
    await expect(
      withTenant(appPool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO appointments (
             tenant_id, customer_id, staff_id, service_id,
             start_at, end_at, occupied_start_at, occupied_end_at, status, source
           ) VALUES ($1,$2,$3,$4,
             '2026-08-27 18:00+00','2026-08-27 18:30+00',
             '2026-08-27 18:00+00','2026-08-27 18:30+00','CONFIRMED','INTERNAL')`,
          [TENANT_A, ids.custA, ids.staffA, ids.svcB],
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      withTenant(appPool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO appointments (
             tenant_id, customer_id, staff_id, service_id,
             start_at, end_at, occupied_start_at, occupied_end_at, status, source
           ) VALUES ($1,$2,$3,$4,
             '2026-08-27 19:00+00','2026-08-27 19:30+00',
             '2026-08-27 19:00+00','2026-08-27 19:30+00','CONFIRMED','INTERNAL')`,
          [TENANT_A, ids.custB, ids.staffA, ids.svcA],
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      withTenant(appPool, TENANT_A, async (c) => {
        await c.query(
          `UPDATE staff_members SET location_id = $1 WHERE id = $2`,
          [ids.locB, ids.staffA],
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("appointment CHECKs", () => {
  async function insertTimes(
    start: string,
    end: string,
    occStart: string,
    occEnd: string,
  ) {
    return withTenant(appPool, TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO appointments (
           tenant_id, customer_id, staff_id, service_id,
           start_at, end_at, occupied_start_at, occupied_end_at, status, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED','INTERNAL')`,
        [TENANT_A, ids.custA, ids.staffA, ids.svcA, start, end, occStart, occEnd],
      );
    });
  }

  it("rejects start_at >= end_at", async () => {
    await expect(
      insertTimes(
        "2026-08-28 10:30+00",
        "2026-08-28 10:00+00",
        "2026-08-28 10:00+00",
        "2026-08-28 10:35+00",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects occupied_start_at >= occupied_end_at", async () => {
    await expect(
      insertTimes(
        "2026-08-28 10:00+00",
        "2026-08-28 10:30+00",
        "2026-08-28 10:30+00",
        "2026-08-28 10:00+00",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects occupied range that does not cover the service interval", async () => {
    await expect(
      insertTimes(
        "2026-08-28 10:00+00",
        "2026-08-28 10:30+00",
        "2026-08-28 10:05+00",
        "2026-08-28 10:30+00",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertTimes(
        "2026-08-28 12:00+00",
        "2026-08-28 12:30+00",
        "2026-08-28 12:00+00",
        "2026-08-28 12:20+00",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("GiST exclusion", () => {
  it("allows one confirmed appointment and rejects an overlapping concurrent insert", async () => {
    const start = "2026-08-29 14:00:00+00";
    const end = "2026-08-29 14:30:00+00";
    const occEnd = "2026-08-29 14:35:00+00";
    const sql = `INSERT INTO appointments (
             tenant_id, customer_id, staff_id, service_id,
             start_at, end_at, occupied_start_at, occupied_end_at, status, source
           ) VALUES ($1,$2,$3,$4,$5,$6,$5,$7,'CONFIRMED','INTERNAL') RETURNING id`;
    const params = [TENANT_A, ids.custA, ids.staffA, ids.svcA, start, end, occEnd];

    const results = await Promise.allSettled([
      withTenant(appPool, TENANT_A, (c) => c.query(sql, params)),
      withTenant(appPool, TENANT_A, (c) => c.query(sql, params)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(reason.code === "SLOT_NO_LONGER_AVAILABLE" || reason instanceof Errors.slotNoLongerAvailable().constructor).toBe(
      true,
    );
    expect((reason as { code: string }).code).toBe("SLOT_NO_LONGER_AVAILABLE");
  });

  it("does not rewrite occupancy when service buffers change", async () => {
    const row = await withTenant(appPool, TENANT_A, async (c) => {
      const ins = await c.query(
        `INSERT INTO appointments (
           tenant_id, customer_id, staff_id, service_id,
           start_at, end_at, occupied_start_at, occupied_end_at, status, source
         ) VALUES ($1,$2,$3,$4,
           '2026-08-30 11:00+00','2026-08-30 11:30+00',
           '2026-08-30 11:00+00','2026-08-30 11:35+00','CONFIRMED','INTERNAL')
         RETURNING occupied_end_at`,
        [TENANT_A, ids.custA, ids.staffA, ids.svcA],
      );
      await c.query(`UPDATE services SET buffer_after_minutes = 20 WHERE id = $1`, [ids.svcA]);
      const after = await c.query(
        `SELECT occupied_end_at FROM appointments WHERE occupied_start_at = '2026-08-30 11:00+00'`,
      );
      return { before: ins.rows[0].occupied_end_at, after: after.rows[0].occupied_end_at };
    });
    expect(new Date(row.after).getTime()).toBe(new Date(row.before).getTime());
  });
});

describe("audit append-only", () => {
  it("allows insert and forbids update/delete for tavo_app", async () => {
    const id = await withTenant(appPool, TENANT_A, async (c) => {
      const r = await c.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, object_type)
         VALUES ($1,'SYSTEM','t','appointment.created','appointment') RETURNING id`,
        [TENANT_A],
      );
      return r.rows[0].id as string;
    });
    const c = await appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      await expect(c.query(`UPDATE audit_events SET action = 'x' WHERE id = $1`, [id])).rejects.toThrow();
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      await expect(c.query(`DELETE FROM audit_events WHERE id = $1`, [id])).rejects.toThrow();
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("schema_migrations", () => {
  it("is owned by tavo_migrator and not readable by tavo_app", async () => {
    const owner = await superClient.query<{ owner: string }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'`,
    );
    expect(owner.rows[0]?.owner).toBe("tavo_migrator");
    const c = await appPool.connect();
    try {
      await expect(c.query(`SELECT filename FROM schema_migrations`)).rejects.toThrow();
    } finally {
      c.release();
    }
  });
});

describe("schema hygiene", () => {
  it("has no card-data columns", async () => {
    const r = await superClient.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name ~* '(pan|card_number|cvv|cvc|credit_card)'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("creates btree_gist and the occupied exclusion constraint", async () => {
    const ext = await superClient.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(ext.rowCount).toBe(1);
    const con = await superClient.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'appointments_occupied_excl'`,
    );
    const def = con.rows[0].def as string;
    expect(def).toContain("EXCLUDE USING gist");
    expect(def).toContain("tenant_id");
    expect(def).toContain("staff_id");
    expect(def).toContain("occupied_start_at");
    expect(def).toContain("CONFIRMED");
  });
});
