import type { Pool, PoolClient } from "pg";
import { isExclusionViolation, Errors } from "@tavo/shared";

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", ["app.tenant_id", tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    if (isExclusionViolation(err)) {
      throw Errors.slotNoLongerAvailable();
    }
    throw err;
  } finally {
    client.release();
  }
}
