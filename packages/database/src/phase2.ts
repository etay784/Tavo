import type { PoolClient } from "pg";
import type { AppointmentRow } from "./repos";

export async function listServices(client: PoolClient, tenantId: string) {
  const r = await client.query<{
    id: string;
    name: string;
    duration_minutes: number;
    price_minor: number;
    active: boolean;
  }>(
    `SELECT id, name, duration_minutes, price_minor, active
     FROM services WHERE tenant_id = $1 AND active = true ORDER BY name`,
    [tenantId],
  );
  return r.rows;
}

export async function getCustomer(
  client: PoolClient,
  tenantId: string,
  customerId: string,
) {
  const r = await client.query<{
    id: string;
    name: string | null;
    phone_encrypted: string;
    phone_encryption_key_version: number;
  }>(
    `SELECT id, name, phone_encrypted, phone_encryption_key_version
     FROM customers WHERE tenant_id = $1 AND id = $2`,
    [tenantId, customerId],
  );
  return r.rows[0];
}

export async function insertWhatsappIntegration(
  client: PoolClient,
  tenantId: string,
  phoneNumberId: string,
) {
  const r = await client.query<{ id: string; tenant_id: string; phone_number_id: string }>(
    `INSERT INTO whatsapp_integrations (tenant_id, phone_number_id)
     VALUES ($1,$2) RETURNING id, tenant_id, phone_number_id`,
    [tenantId, phoneNumberId],
  );
  return r.rows[0]!;
}

export async function insertInboundEvent(
  client: PoolClient,
  tenantId: string,
  input: {
    integrationId: string;
    providerMessageId: string;
    eventKind: "message_text" | "status" | "unknown";
    status: "RECEIVED" | "IGNORED";
    waTimestamp: Date | null;
    payloadSha256: string;
    senderEncrypted?: string;
    senderEncryptionKeyVersion?: number;
    textEncrypted?: string;
    textEncryptionKeyVersion?: number;
  },
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO whatsapp_inbound_events (
       tenant_id, integration_id, provider_message_id, event_kind, status,
       wa_timestamp, payload_sha256, sender_encrypted, sender_encryption_key_version,
       text_encrypted, text_encryption_key_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      tenantId,
      input.integrationId,
      input.providerMessageId,
      input.eventKind,
      input.status,
      input.waTimestamp,
      input.payloadSha256,
      input.senderEncrypted ?? null,
      input.senderEncryptionKeyVersion ?? null,
      input.textEncrypted ?? null,
      input.textEncryptionKeyVersion ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function getInboundEvent(client: PoolClient, tenantId: string, id: string) {
  const r = await client.query<{
    id: string;
    tenant_id: string;
    conversation_id: string | null;
    integration_id: string;
    provider_message_id: string;
    event_kind: string;
    status: string;
    wa_timestamp: Date | null;
    sender_encrypted: string | null;
    sender_encryption_key_version: number | null;
    text_encrypted: string | null;
    text_encryption_key_version: number | null;
    lock_version: number | null;
  }>(
    `SELECT id, tenant_id, conversation_id, integration_id, provider_message_id,
            event_kind, status, wa_timestamp, sender_encrypted, sender_encryption_key_version,
            text_encrypted, text_encryption_key_version, 0 AS lock_version
     FROM whatsapp_inbound_events WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0];
}

export async function upsertConversation(
  client: PoolClient,
  tenantId: string,
  customerId: string,
) {
  const r = await client.query<{
    id: string;
    customer_id: string;
    state: string;
    lock_version: number;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    service_id: string | null;
    clarify_count: number;
  }>(
    `INSERT INTO conversations (tenant_id, customer_id)
     VALUES ($1,$2)
     ON CONFLICT (tenant_id, customer_id)
     DO UPDATE SET updated_at = now()
     RETURNING id, customer_id, state, lock_version, lease_owner, lease_expires_at,
               service_id, clarify_count`,
    [tenantId, customerId],
  );
  return r.rows[0]!;
}

export async function attachInboundConversation(
  client: PoolClient,
  tenantId: string,
  inboundId: string,
  conversationId: string,
) {
  await client.query(
    `UPDATE whatsapp_inbound_events SET conversation_id = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, inboundId, conversationId],
  );
}

export async function tryAcquireConversationLease(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  workerId: string,
  ttlSeconds: number,
) {
  const r = await client.query<{ lock_version: number }>(
    `UPDATE conversations
     SET lease_owner = $3,
         lease_expires_at = now() + make_interval(secs => $4),
         lock_version = lock_version + 1,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
       AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = $3)
     RETURNING lock_version`,
    [tenantId, conversationId, workerId, ttlSeconds],
  );
  return r.rows[0];
}

export async function releaseConversationLease(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  workerId: string,
  lockVersion: number,
) {
  const r = await client.query(
    `UPDATE conversations
     SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lock_version = $4`,
    [tenantId, conversationId, workerId, lockVersion],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function updateConversationState(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  workerId: string,
  lockVersion: number,
  patch: { state: string; serviceId?: string | null; clarifyCount?: number },
) {
  const r = await client.query(
    `UPDATE conversations
     SET state = $5, service_id = COALESCE($6, service_id),
         clarify_count = COALESCE($7, clarify_count), updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lock_version = $4`,
    [
      tenantId,
      conversationId,
      workerId,
      lockVersion,
      patch.state,
      patch.serviceId ?? null,
      patch.clarifyCount ?? null,
    ],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function markInboundProcessed(
  client: PoolClient,
  tenantId: string,
  id: string,
) {
  await client.query(
    `UPDATE whatsapp_inbound_events
     SET status = 'PROCESSED', lock_expires_at = NULL, locked_by = NULL
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
}

export async function markInboundFailed(
  client: PoolClient,
  tenantId: string,
  id: string,
  error: string,
  retrySeconds: number,
) {
  await client.query(
    `UPDATE whatsapp_inbound_events
     SET status = 'FAILED', last_error = $3, next_attempt_at = now() + make_interval(secs => $4),
         lock_expires_at = NULL, locked_by = NULL
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500), retrySeconds],
  );
}

export async function insertOfferedSlots(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  slots: {
    slotRef: string;
    staffId: string;
    serviceId: string;
    startAt: Date;
    ordinal: number;
    expiresAt: Date;
  }[],
) {
  await client.query(
    `DELETE FROM offered_slots WHERE tenant_id = $1 AND conversation_id = $2 AND consumed_at IS NULL`,
    [tenantId, conversationId],
  );
  for (const s of slots) {
    await client.query(
      `INSERT INTO offered_slots (
         tenant_id, conversation_id, slot_ref, staff_id, service_id, start_at, ordinal, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, conversationId, s.slotRef, s.staffId, s.serviceId, s.startAt, s.ordinal, s.expiresAt],
    );
  }
}

export async function listOpenOfferedSlots(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
) {
  const r = await client.query<{
    slot_ref: string;
    staff_id: string;
    service_id: string;
    start_at: Date;
    ordinal: number;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT slot_ref, staff_id, service_id, start_at, ordinal, expires_at, consumed_at
     FROM offered_slots
     WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY ordinal`,
    [tenantId, conversationId],
  );
  return r.rows;
}

export async function lockOfferedSlot(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  slotRef: string,
) {
  const r = await client.query<{
    slot_ref: string;
    staff_id: string;
    service_id: string;
    start_at: Date;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT slot_ref, staff_id, service_id, start_at, expires_at, consumed_at
     FROM offered_slots
     WHERE tenant_id = $1 AND conversation_id = $2 AND slot_ref = $3
     FOR UPDATE`,
    [tenantId, conversationId, slotRef],
  );
  return r.rows[0];
}

export async function consumeOfferedSlot(
  client: PoolClient,
  tenantId: string,
  slotRef: string,
  inboundEventId: string,
) {
  const r = await client.query(
    `UPDATE offered_slots
     SET consumed_at = now(), consumed_by_inbound_event_id = $3
     WHERE tenant_id = $1 AND slot_ref = $2 AND consumed_at IS NULL`,
    [tenantId, slotRef, inboundEventId],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function getBookingCommand(client: PoolClient, tenantId: string, commandKey: string) {
  const r = await client.query<{
    appointment_id: string;
    operation: string;
    result_json: unknown;
  }>(
    `SELECT appointment_id, operation, result_json
     FROM booking_commands WHERE tenant_id = $1 AND command_key = $2`,
    [tenantId, commandKey],
  );
  return r.rows[0];
}

export async function insertBookingCommand(
  client: PoolClient,
  tenantId: string,
  input: {
    commandKey: string;
    operation: "CREATE" | "RESCHEDULE" | "CANCEL";
    inboundEventId: string;
    appointmentId: string;
    resultJson: unknown;
  },
) {
  await client.query(
    `INSERT INTO booking_commands (
       tenant_id, command_key, operation, inbound_event_id, appointment_id, result_json
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      tenantId,
      input.commandKey,
      input.operation,
      input.inboundEventId,
      input.appointmentId,
      JSON.stringify(input.resultJson),
    ],
  );
}

export async function insertOutboundMessage(
  client: PoolClient,
  tenantId: string,
  input: {
    customerId: string;
    integrationId: string;
    conversationId: string;
    causedByInboundEventId: string;
    bodyEncrypted: string;
    messageEncryptionKeyVersion: number;
  },
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO whatsapp_outbound_messages (
       tenant_id, customer_id, integration_id, conversation_id, caused_by_inbound_event_id,
       body_encrypted, message_encryption_key_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      tenantId,
      input.customerId,
      input.integrationId,
      input.conversationId,
      input.causedByInboundEventId,
      input.bodyEncrypted,
      input.messageEncryptionKeyVersion,
    ],
  );
  return r.rows[0]!;
}

export async function getOutboundMessage(client: PoolClient, tenantId: string, id: string) {
  const r = await client.query<{
    id: string;
    customer_id: string;
    integration_id: string;
    conversation_id: string;
    status: string;
    body_encrypted: string;
    message_encryption_key_version: number;
    provider_message_id: string | null;
  }>(
    `SELECT id, customer_id, integration_id, conversation_id, status, body_encrypted,
            message_encryption_key_version, provider_message_id
     FROM whatsapp_outbound_messages WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0];
}

export async function markOutboundSent(
  client: PoolClient,
  tenantId: string,
  id: string,
  providerMessageId: string,
) {
  await client.query(
    `UPDATE whatsapp_outbound_messages
     SET status = 'SENT', provider_message_id = $3, lock_expires_at = NULL, locked_by = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, providerMessageId],
  );
}

export async function markOutboundFailed(
  client: PoolClient,
  tenantId: string,
  id: string,
  error: string,
) {
  await client.query(
    `UPDATE whatsapp_outbound_messages
     SET status = 'FAILED', last_error = $3, lock_expires_at = NULL, locked_by = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500)],
  );
}

export async function markOutboundAmbiguous(
  client: PoolClient,
  tenantId: string,
  id: string,
  error: string,
) {
  await client.query(
    `UPDATE whatsapp_outbound_messages
     SET status = 'AMBIGUOUS', last_error = $3, lock_expires_at = NULL, locked_by = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500)],
  );
}

export async function getIntegration(client: PoolClient, tenantId: string, id: string) {
  const r = await client.query<{ id: string; phone_number_id: string }>(
    `SELECT id, phone_number_id FROM whatsapp_integrations WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0];
}

export async function insertChatMessage(
  client: PoolClient,
  tenantId: string,
  input: {
    conversationId: string;
    direction: "INBOUND" | "OUTBOUND";
    bodyEncrypted: string;
    messageEncryptionKeyVersion: number;
    inboundEventId?: string;
    outboundId?: string;
  },
) {
  await client.query(
    `INSERT INTO messages (
       tenant_id, conversation_id, direction, body_encrypted, message_encryption_key_version,
       inbound_event_id, outbound_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      tenantId,
      input.conversationId,
      input.direction,
      input.bodyEncrypted,
      input.messageEncryptionKeyVersion,
      input.inboundEventId ?? null,
      input.outboundId ?? null,
    ],
  );
}

export async function listCustomerAppointments(
  client: PoolClient,
  tenantId: string,
  customerId: string,
) {
  const r = await client.query<AppointmentRow>(
    `SELECT id, tenant_id, customer_id, staff_id, service_id, location_id,
            start_at, end_at, occupied_start_at, occupied_end_at, status, source
     FROM appointments
     WHERE tenant_id = $1 AND customer_id = $2 AND status = 'CONFIRMED'
     ORDER BY start_at`,
    [tenantId, customerId],
  );
  return r.rows;
}
