import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { startEphemeralPostgres, waitForPg, type EphemeralPg } from "./ephemeral-pg";
import { applyMigrations } from "./migrate";
import { withTenant } from "./tenant";
import { consumeLlmBudgetWindow } from "./phase2";

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("durable LLM budget admission", () => {
  let pg: EphemeralPg;
  let pool: Pool;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(`INSERT INTO businesses (id, name, timezone) VALUES ($1,'Budget','Asia/Jerusalem')`, [
      TENANT,
    ]);
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 12 });
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await pg.stop();
  });

  it("does not spend tenant quota on a sender that is already over limit", async () => {
    const now = new Date("2026-08-25T10:00:00.000Z");
    const first = await withTenant(pool, TENANT, (c) =>
      consumeLlmBudgetWindow(c, TENANT, "sender-a", now, 2, 8),
    );
    const second = await withTenant(pool, TENANT, (c) =>
      consumeLlmBudgetWindow(c, TENANT, "sender-a", now, 2, 8),
    );
    expect(first).toBe(true);
    expect(second).toBe(true);
    const spam = await Promise.all(
      Array.from({ length: 12 }, () =>
        withTenant(pool, TENANT, (c) => consumeLlmBudgetWindow(c, TENANT, "sender-a", now, 2, 8)),
      ),
    );
    expect(spam.every((ok) => ok === false)).toBe(true);
    const tenantHits = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ hit_count: number }>(
        `SELECT hit_count FROM llm_budget_windows
         WHERE tenant_id = $1 AND window_kind = 'tenant_hour'`,
        [TENANT],
      );
      return r.rows[0]?.hit_count ?? 0;
    });
    expect(tenantHits).toBe(2);
    const other = await withTenant(pool, TENANT, (c) =>
      consumeLlmBudgetWindow(c, TENANT, "sender-b", now, 2, 8),
    );
    expect(other).toBe(true);
    const after = await withTenant(pool, TENANT, async (c) => {
      const r = await c.query<{ hit_count: number }>(
        `SELECT hit_count FROM llm_budget_windows
         WHERE tenant_id = $1 AND window_kind = 'tenant_hour'`,
        [TENANT],
      );
      return r.rows[0]!.hit_count;
    });
    expect(after).toBe(3);
  });
});
