import type { PoolClient } from "pg";

export async function resolveWhatsappIntegration(client: PoolClient, phoneNumberId: string) {
  const r = await client.query<{ tenant_id: string; integration_id: string }>(
    `SELECT tenant_id, integration_id FROM tavo_routing.resolve_whatsapp_integration($1)`,
    [phoneNumberId],
  );
  return r.rows[0];
}

export async function claimNextInboundJob(client: PoolClient, workerId: string) {
  const r = await client.query<{ job_id: string; tenant_id: string }>(
    `SELECT job_id, tenant_id FROM tavo_routing.claim_next_inbound_job($1)`,
    [workerId],
  );
  return r.rows[0];
}

export async function claimNextOutboundJob(client: PoolClient, workerId: string) {
  const r = await client.query<{ outbox_id: string; tenant_id: string }>(
    `SELECT outbox_id, tenant_id FROM tavo_routing.claim_next_outbound_job($1)`,
    [workerId],
  );
  return r.rows[0];
}

export async function insertSystemSecurityEvent(
  client: PoolClient,
  eventType: string,
  details: Record<string, string>,
) {
  await client.query(`SELECT tavo_routing.insert_system_security_event($1, $2::jsonb)`, [
    eventType,
    JSON.stringify(details),
  ]);
}
