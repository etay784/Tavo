import type { PoolClient } from "pg";
import { insertWhatsappIntegration } from "./phase2";
import { insertService, insertStaff, insertStaffService, upsertWorkingHours } from "./repos";

export const DEMO_TENANT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
export const DEMO_BUSINESS_NAME = "Tavo Demo Barbers";

async function ensureStaff(client: PoolClient, tenantId: string, name: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM staff_members WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
    [tenantId, name],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const row = await insertStaff(client, tenantId, name, null);
  return row.id;
}

async function ensureService(
  client: PoolClient,
  tenantId: string,
  name: string,
  durationMinutes: number,
  priceMinor: number,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM services WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
    [tenantId, name],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const row = await insertService(client, tenantId, {
    name,
    durationMinutes,
    priceMinor,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
  });
  return row.id;
}

/**
 * Idempotent demo catalog: תספורת, זקן, תספורת + זקן;
 * Daniel Sun–Thu 09–19; Gil Sun–Thu 14–21.
 */
export async function seedTavoDemoBarbers(
  client: PoolClient,
  input: { tenantId?: string; phoneNumberId?: string } = {},
): Promise<{ tenantId: string; staff: { daniel: string; gil: string } }> {
  const tenantId = input.tenantId ?? DEMO_TENANT_ID;
  await client.query(
    `INSERT INTO businesses (id, name, timezone)
     VALUES ($1, $2, 'Asia/Jerusalem')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [tenantId, DEMO_BUSINESS_NAME],
  );
  const daniel = await ensureStaff(client, tenantId, "Daniel");
  const gil = await ensureStaff(client, tenantId, "Gil");
  const haircut = await ensureService(client, tenantId, "תספורת", 30, 8000);
  const beard = await ensureService(client, tenantId, "זקן", 20, 5000);
  const combo = await ensureService(client, tenantId, "תספורת + זקן", 45, 12000);
  for (const serviceId of [haircut, beard, combo]) {
    await insertStaffService(client, tenantId, daniel, serviceId);
    await insertStaffService(client, tenantId, gil, serviceId);
  }
  for (const dow of [0, 1, 2, 3, 4]) {
    await upsertWorkingHours(client, tenantId, daniel, dow, "09:00", "19:00");
    await upsertWorkingHours(client, tenantId, gil, dow, "14:00", "21:00");
  }
  if (input.phoneNumberId) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM whatsapp_integrations WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    if (!existing.rows[0]) {
      await insertWhatsappIntegration(client, tenantId, input.phoneNumberId);
    }
  }
  return { tenantId, staff: { daniel, gil } };
}
