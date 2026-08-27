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
    attempt_count: number;
  }>(
    `SELECT id, tenant_id, conversation_id, integration_id, provider_message_id,
            event_kind, status, wa_timestamp, sender_encrypted, sender_encryption_key_version,
            text_encrypted, text_encryption_key_version, 0 AS lock_version, attempt_count
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
    lease_token: string | null;
    service_id: string | null;
    clarify_count: number;
    current_offer_set_id: string | null;
    pending_appointment_id: string | null;
    pending_request: unknown;
  }>(
    `INSERT INTO conversations (tenant_id, customer_id)
     VALUES ($1,$2)
     ON CONFLICT (tenant_id, customer_id)
     DO UPDATE SET updated_at = now()
     RETURNING id, customer_id, state, lock_version, lease_owner, lease_expires_at, lease_token,
               service_id, clarify_count, current_offer_set_id, pending_appointment_id, pending_request`,
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
  leaseToken: string,
  ttlSeconds: number,
) {
  const r = await client.query<{ lock_version: number; lease_token: string }>(
    `UPDATE conversations
     SET lease_owner = $3,
         lease_token = $3,
         lease_expires_at = now() + make_interval(secs => $4),
         lock_version = lock_version + 1,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING lock_version, lease_token`,
    [tenantId, conversationId, leaseToken, ttlSeconds],
  );
  return r.rows[0];
}

export async function releaseConversationLease(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  leaseToken: string,
  lockVersion: number,
) {
  const r = await client.query(
    `UPDATE conversations
     SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND lock_version = $4`,
    [tenantId, conversationId, leaseToken, lockVersion],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function lockConversationLease(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  leaseToken: string,
  lockVersion: number,
) {
  const r = await client.query<{ lock_version: number }>(
    `SELECT lock_version FROM conversations
     WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND lock_version = $4
       AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
     FOR UPDATE`,
    [tenantId, conversationId, leaseToken, lockVersion],
  );
  return r.rows[0];
}

export async function updateConversationState(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  leaseToken: string,
  lockVersion: number,
  patch: {
    state: string;
    serviceId?: string | null;
    pendingAppointmentId?: string | null;
    currentOfferSetId?: string | null;
    pendingRequest?: unknown;
    clarifyCount?: number;
  },
) {
  const r = await client.query(
    `UPDATE conversations
     SET state = $5,
         service_id = $6,
         pending_appointment_id = $7,
         current_offer_set_id = $8,
         pending_request = $10::jsonb,
         clarify_count = COALESCE($9, clarify_count),
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND lock_version = $4
       AND lease_expires_at IS NOT NULL AND lease_expires_at > now()`,
    [
      tenantId,
      conversationId,
      leaseToken,
      lockVersion,
      patch.state,
      patch.serviceId ?? null,
      patch.pendingAppointmentId ?? null,
      patch.currentOfferSetId ?? null,
      patch.clarifyCount ?? null,
      patch.pendingRequest == null ? null : JSON.stringify(patch.pendingRequest),
    ],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function markInboundDeferred(
  client: PoolClient,
  tenantId: string,
  id: string,
  retrySeconds: number,
) {
  await client.query(
    `UPDATE whatsapp_inbound_events
     SET status = 'RECEIVED',
         attempt_count = GREATEST(attempt_count - 1, 0),
         next_attempt_at = now() + make_interval(secs => $3),
         lock_expires_at = NULL,
         locked_by = NULL,
         last_error = 'conversation_busy'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, retrySeconds],
  );
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
  maxAttempts: number,
) {
  await client.query(
    `UPDATE whatsapp_inbound_events
     SET status = CASE WHEN attempt_count >= $5 THEN 'DEAD'::inbound_event_status ELSE 'FAILED'::inbound_event_status END,
         last_error = $3,
         next_attempt_at = now() + make_interval(secs => $4),
         lock_expires_at = NULL, locked_by = NULL
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500), retrySeconds, maxAttempts],
  );
}

export async function insertOfferedSlots(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  offerSetId: string,
  slots: {
    slotRef: string;
    staffId: string;
    serviceId: string;
    startAt: Date;
    ordinal: number;
    expiresAt: Date;
  }[],
) {
  for (const s of slots) {
    await client.query(
      `INSERT INTO offered_slots (
         tenant_id, conversation_id, offer_set_id, slot_ref, staff_id, service_id, start_at, ordinal, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        tenantId,
        conversationId,
        offerSetId,
        s.slotRef,
        s.staffId,
        s.serviceId,
        s.startAt,
        s.ordinal,
        s.expiresAt,
      ],
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
    offer_set_id: string;
  }>(
    `SELECT o.slot_ref, o.staff_id, o.service_id, o.start_at, o.ordinal, o.expires_at, o.consumed_at, o.offer_set_id
     FROM offered_slots o
     INNER JOIN conversations c
       ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
     WHERE o.tenant_id = $1 AND o.conversation_id = $2
       AND o.offer_set_id = c.current_offer_set_id
       AND o.consumed_at IS NULL
       AND o.expires_at > now()
     ORDER BY o.ordinal`,
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
    `SELECT o.slot_ref, o.staff_id, o.service_id, o.start_at, o.expires_at, o.consumed_at
     FROM offered_slots o
     INNER JOIN conversations c
       ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
     WHERE o.tenant_id = $1 AND o.conversation_id = $2 AND o.slot_ref = $3
       AND o.offer_set_id = c.current_offer_set_id
     FOR UPDATE OF o`,
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
    attempt_count: number;
  }>(
    `SELECT id, customer_id, integration_id, conversation_id, status, body_encrypted,
            message_encryption_key_version, provider_message_id, attempt_count
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
     SET status = 'FAILED', last_error = $3, lock_expires_at = NULL, locked_by = NULL,
         retry_class = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500)],
  );
}

export async function markOutboundTransient(
  client: PoolClient,
  tenantId: string,
  id: string,
  error: string,
  retrySeconds: number,
  maxAttempts: number,
) {
  await client.query(
    `UPDATE whatsapp_outbound_messages
     SET status = CASE WHEN attempt_count >= $5 THEN 'FAILED'::outbound_message_status ELSE 'PENDING'::outbound_message_status END,
         retry_class = CASE WHEN attempt_count >= $5 THEN NULL ELSE 'TRANSIENT' END,
         last_error = $3,
         next_attempt_at = now() + make_interval(secs => $4),
         lock_expires_at = NULL, locked_by = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 500), retrySeconds, maxAttempts],
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
  now: Date,
) {
  const r = await client.query<AppointmentRow>(
    `SELECT id, tenant_id, customer_id, staff_id, service_id, location_id,
            start_at, end_at, occupied_start_at, occupied_end_at, status, source
     FROM appointments
     WHERE tenant_id = $1 AND customer_id = $2 AND customer_id IS NOT NULL
       AND status = 'CONFIRMED' AND start_at > $3 AND source <> 'BLOCKED'
     ORDER BY start_at`,
    [tenantId, customerId, now],
  );
  return r.rows;
}

export async function listStaffNames(client: PoolClient, tenantId: string) {
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM staff_members WHERE tenant_id = $1 AND active = true ORDER BY name`,
    [tenantId],
  );
  return r.rows;
}

export async function consumeLlmBudgetWindow(
  client: PoolClient,
  tenantId: string,
  senderSubject: string,
  now: Date,
  senderPerMinute: number,
  tenantPerHour: number,
): Promise<boolean> {
  await client.query(
    `DELETE FROM llm_budget_windows WHERE tenant_id = $1 AND window_start < $2`,
    [tenantId, new Date(now.getTime() - 3 * 60 * 60 * 1000)],
  );
  const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const sender = await client.query<{ hit_count: number }>(
    `INSERT INTO llm_budget_windows (tenant_id, subject_key, window_kind, window_start, hit_count)
     VALUES ($1, $2, 'sender_minute', $3, 1)
     ON CONFLICT (tenant_id, subject_key, window_kind, window_start)
     DO UPDATE SET hit_count = llm_budget_windows.hit_count + 1
     WHERE llm_budget_windows.hit_count < $4
     RETURNING hit_count`,
    [tenantId, senderSubject, minuteStart, senderPerMinute],
  );
  if (!sender.rows[0]) {
    return false;
  }
  const tenant = await client.query<{ hit_count: number }>(
    `INSERT INTO llm_budget_windows (tenant_id, subject_key, window_kind, window_start, hit_count)
     VALUES ($1, 'tenant', 'tenant_hour', $2, 1)
     ON CONFLICT (tenant_id, subject_key, window_kind, window_start)
     DO UPDATE SET hit_count = llm_budget_windows.hit_count + 1
     WHERE llm_budget_windows.hit_count < $3
     RETURNING hit_count`,
    [tenantId, hourStart, tenantPerHour],
  );
  if (!tenant.rows[0]) {
    await client.query(
      `UPDATE llm_budget_windows
       SET hit_count = hit_count - 1
       WHERE tenant_id = $1 AND subject_key = $2 AND window_kind = 'sender_minute'
         AND window_start = $3 AND hit_count > 0`,
      [tenantId, senderSubject, minuteStart],
    );
    return false;
  }
  return true;
}

export type RoutingState = "UNKNOWN" | "BUSINESS_VERIFIED" | "PERSONAL_EXCLUDED" | "HUMAN_ONLY";
export type RoutingSource = "OWNER" | "DETERMINISTIC" | "SYSTEM";

export type ConversationRoutingRow = {
  tenant_id: string;
  conversation_id: string;
  customer_id: string;
  routing_state: RoutingState;
  state_source: RoutingSource;
  owner_locked: boolean;
  evidence_codes: string[];
  classifier_invoked_at: Date | null;
  classifier_label: "BUSINESS" | "UNKNOWN" | null;
};

export async function customerHasAppointmentHistory(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM appointments
       WHERE tenant_id = $1 AND customer_id = $2
         AND customer_id IS NOT NULL AND source <> 'BLOCKED'
     ) AS exists`,
    [tenantId, customerId],
  );
  return r.rows[0]?.exists === true;
}

export async function getOrCreateConversationRouting(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  customerId: string,
): Promise<ConversationRoutingRow> {
  const existing = await client.query<ConversationRoutingRow>(
    `SELECT tenant_id, conversation_id, customer_id, routing_state, state_source,
            owner_locked, evidence_codes, classifier_invoked_at, classifier_label
     FROM conversation_routing
     WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, conversationId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const inserted = await client.query<ConversationRoutingRow>(
    `INSERT INTO conversation_routing (
       tenant_id, conversation_id, customer_id, routing_state, state_source, owner_locked
     ) VALUES ($1,$2,$3,'UNKNOWN','DETERMINISTIC', false)
     ON CONFLICT (tenant_id, conversation_id) DO UPDATE SET customer_id = EXCLUDED.customer_id
     RETURNING tenant_id, conversation_id, customer_id, routing_state, state_source,
               owner_locked, evidence_codes, classifier_invoked_at, classifier_label`,
    [tenantId, conversationId, customerId],
  );
  return inserted.rows[0]!;
}

export async function setOwnerConversationRouting(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  customerId: string,
  routingState: RoutingState,
  evidenceCodes: string[] = ["owner_override"],
): Promise<ConversationRoutingRow> {
  await getOrCreateConversationRouting(client, tenantId, conversationId, customerId);
  const r = await client.query<ConversationRoutingRow>(
    `UPDATE conversation_routing
     SET routing_state = $3,
         state_source = 'OWNER',
         owner_locked = true,
         evidence_codes = $4,
         updated_at = now()
     WHERE tenant_id = $1 AND conversation_id = $2
     RETURNING tenant_id, conversation_id, customer_id, routing_state, state_source,
               owner_locked, evidence_codes, classifier_invoked_at, classifier_label`,
    [tenantId, conversationId, routingState, evidenceCodes],
  );
  return r.rows[0]!;
}

export async function persistBusinessVerified(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  evidenceCodes: string[],
): Promise<ConversationRoutingRow | null> {
  const r = await client.query<ConversationRoutingRow>(
    `UPDATE conversation_routing
     SET routing_state = 'BUSINESS_VERIFIED',
         state_source = 'DETERMINISTIC',
         evidence_codes = $3,
         updated_at = now()
     WHERE tenant_id = $1
       AND conversation_id = $2
       AND owner_locked = false
       AND routing_state IN ('UNKNOWN', 'BUSINESS_VERIFIED')
     RETURNING tenant_id, conversation_id, customer_id, routing_state, state_source,
               owner_locked, evidence_codes, classifier_invoked_at, classifier_label`,
    [tenantId, conversationId, evidenceCodes],
  );
  return r.rows[0] ?? null;
}

export async function recordClassifierInvocation(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  label: "BUSINESS" | "UNKNOWN",
): Promise<void> {
  await client.query(
    `UPDATE conversation_routing
     SET classifier_invoked_at = now(),
         classifier_label = $3,
         updated_at = now()
     WHERE tenant_id = $1 AND conversation_id = $2 AND owner_locked = false`,
    [tenantId, conversationId, label],
  );
}
