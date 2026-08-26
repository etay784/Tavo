import type { PoolClient } from "pg";

export type BusinessRow = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  booking_horizon_days: number;
  min_advance_minutes: number;
  slot_granularity_minutes: number;
};

export type ServiceRow = {
  id: string;
  tenant_id: string;
  name: string;
  duration_minutes: number;
  price_minor: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  active: boolean;
};

export type StaffRow = {
  id: string;
  tenant_id: string;
  location_id: string | null;
  name: string;
  active: boolean;
};

export type AppointmentRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  staff_id: string;
  service_id: string;
  location_id: string | null;
  start_at: Date;
  end_at: Date;
  occupied_start_at: Date;
  occupied_end_at: Date;
  status: "CONFIRMED" | "CANCELLED";
  source: string;
};

export async function getBusiness(client: PoolClient, tenantId: string) {
  const r = await client.query<BusinessRow>(
    `SELECT id, name, timezone, currency, booking_horizon_days, min_advance_minutes, slot_granularity_minutes
     FROM businesses WHERE id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

export async function insertStaff(
  client: PoolClient,
  tenantId: string,
  name: string,
  locationId: string | null,
) {
  const r = await client.query<StaffRow>(
    `INSERT INTO staff_members (tenant_id, name, location_id)
     VALUES ($1, $2, $3)
     RETURNING id, tenant_id, location_id, name, active`,
    [tenantId, name, locationId],
  );
  return r.rows[0]!;
}

export async function insertService(
  client: PoolClient,
  tenantId: string,
  input: {
    name: string;
    durationMinutes: number;
    priceMinor: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  },
) {
  const r = await client.query<ServiceRow>(
    `INSERT INTO services (
       tenant_id, name, duration_minutes, price_minor,
       buffer_before_minutes, buffer_after_minutes
     ) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, tenant_id, name, duration_minutes, price_minor,
               buffer_before_minutes, buffer_after_minutes, active`,
    [
      tenantId,
      input.name,
      input.durationMinutes,
      input.priceMinor,
      input.bufferBeforeMinutes,
      input.bufferAfterMinutes,
    ],
  );
  return r.rows[0]!;
}

export async function insertStaffService(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  serviceId: string,
) {
  await client.query(
    `INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1,$2,$3)`,
    [tenantId, staffId, serviceId],
  );
}

export async function insertWorkingHours(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
) {
  await client.query(
    `INSERT INTO working_hours (tenant_id, staff_id, day_of_week, start_time, end_time)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, staffId, dayOfWeek, startTime, endTime],
  );
}

export async function insertBreak(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  startsAt: Date,
  endsAt: Date,
) {
  await client.query(
    `INSERT INTO breaks (tenant_id, staff_id, starts_at, ends_at) VALUES ($1,$2,$3,$4)`,
    [tenantId, staffId, startsAt, endsAt],
  );
}

export async function insertTimeOff(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  startsAt: Date,
  endsAt: Date,
) {
  await client.query(
    `INSERT INTO time_off (tenant_id, staff_id, starts_at, ends_at) VALUES ($1,$2,$3,$4)`,
    [tenantId, staffId, startsAt, endsAt],
  );
}

export async function getService(client: PoolClient, tenantId: string, serviceId: string) {
  const r = await client.query<ServiceRow>(
    `SELECT id, tenant_id, name, duration_minutes, price_minor,
            buffer_before_minutes, buffer_after_minutes, active
     FROM services WHERE tenant_id = $1 AND id = $2`,
    [tenantId, serviceId],
  );
  return r.rows[0];
}

export async function getStaff(client: PoolClient, tenantId: string, staffId: string) {
  const r = await client.query<StaffRow>(
    `SELECT id, tenant_id, location_id, name, active FROM staff_members WHERE tenant_id = $1 AND id = $2`,
    [tenantId, staffId],
  );
  return r.rows[0];
}

export async function staffOffersService(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  serviceId: string,
) {
  const r = await client.query(
    `SELECT 1 FROM staff_services WHERE tenant_id = $1 AND staff_id = $2 AND service_id = $3 AND active = true`,
    [tenantId, staffId, serviceId],
  );
  return r.rowCount === 1;
}

export async function listEligibleStaff(
  client: PoolClient,
  tenantId: string,
  serviceId: string,
) {
  const r = await client.query<StaffRow>(
    `SELECT s.id, s.tenant_id, s.location_id, s.name, s.active
     FROM staff_members s
     JOIN staff_services ss ON ss.tenant_id = s.tenant_id AND ss.staff_id = s.id
     WHERE s.tenant_id = $1 AND ss.service_id = $2 AND s.active = true AND ss.active = true`,
    [tenantId, serviceId],
  );
  return r.rows;
}

export async function listWorkingHours(client: PoolClient, tenantId: string, staffId: string) {
  const r = await client.query<{ day_of_week: number; start_time: string; end_time: string }>(
    `SELECT day_of_week, start_time::text, end_time::text
     FROM working_hours WHERE tenant_id = $1 AND staff_id = $2`,
    [tenantId, staffId],
  );
  return r.rows;
}

export async function listBreaks(client: PoolClient, tenantId: string, staffId: string, from: Date, to: Date) {
  const r = await client.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM breaks
     WHERE tenant_id = $1 AND staff_id = $2 AND starts_at < $4 AND ends_at > $3`,
    [tenantId, staffId, from, to],
  );
  return r.rows;
}

export async function listTimeOff(client: PoolClient, tenantId: string, staffId: string, from: Date, to: Date) {
  const r = await client.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM time_off
     WHERE tenant_id = $1 AND staff_id = $2 AND starts_at < $4 AND ends_at > $3`,
    [tenantId, staffId, from, to],
  );
  return r.rows;
}

export async function listOccupied(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  from: Date,
  to: Date,
  exceptAppointmentId?: string,
) {
  const r = await client.query<{ occupied_start_at: Date; occupied_end_at: Date }>(
    `SELECT occupied_start_at, occupied_end_at FROM appointments
     WHERE tenant_id = $1 AND staff_id = $2 AND status = 'CONFIRMED'
       AND occupied_start_at < $4 AND occupied_end_at > $3
       AND ($5::uuid IS NULL OR id <> $5)`,
    [tenantId, staffId, from, to, exceptAppointmentId ?? null],
  );
  return r.rows;
}

export async function findCustomerByLookup(
  client: PoolClient,
  tenantId: string,
  candidates: { hash: string; version: number }[],
) {
  if (candidates.length === 0) return undefined;
  const versions = candidates.map((c) => c.version);
  const hashes = candidates.map((c) => c.hash);
  const r = await client.query<{
    id: string;
    name: string | null;
    phone_encrypted: string;
    phone_encryption_key_version: number;
  }>(
    `SELECT id, name, phone_encrypted, phone_encryption_key_version
     FROM customers
     WHERE tenant_id = $1
       AND (phone_lookup_key_version, phone_lookup_hash) IN (
         SELECT * FROM unnest($2::int[], $3::text[])
       )`,
    [tenantId, versions, hashes],
  );
  return r.rows[0];
}

export async function insertCustomer(
  client: PoolClient,
  tenantId: string,
  input: {
    name: string | null;
    phoneEncrypted: string;
    phoneEncryptionKeyVersion: number;
    phoneLookupHash: string;
    phoneLookupKeyVersion: number;
  },
) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO customers (
       tenant_id, name, phone_encrypted, phone_encryption_key_version,
       phone_lookup_hash, phone_lookup_key_version, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6, now())
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.phoneEncrypted,
      input.phoneEncryptionKeyVersion,
      input.phoneLookupHash,
      input.phoneLookupKeyVersion,
    ],
  );
  return r.rows[0]!;
}

export async function insertAppointment(
  client: PoolClient,
  tenantId: string,
  input: {
    customerId: string;
    staffId: string;
    serviceId: string;
    locationId: string | null;
    startAt: Date;
    endAt: Date;
    occupiedStartAt: Date;
    occupiedEndAt: Date;
    source: string;
  },
) {
  const r = await client.query<AppointmentRow>(
    `INSERT INTO appointments (
       tenant_id, customer_id, staff_id, service_id, location_id,
       start_at, end_at, occupied_start_at, occupied_end_at, status, source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONFIRMED',$10)
     RETURNING id, tenant_id, customer_id, staff_id, service_id, location_id,
               start_at, end_at, occupied_start_at, occupied_end_at, status, source`,
    [
      tenantId,
      input.customerId,
      input.staffId,
      input.serviceId,
      input.locationId,
      input.startAt,
      input.endAt,
      input.occupiedStartAt,
      input.occupiedEndAt,
      input.source,
    ],
  );
  return r.rows[0]!;
}

export async function getAppointment(client: PoolClient, tenantId: string, id: string) {
  const r = await client.query<AppointmentRow>(
    `SELECT id, tenant_id, customer_id, staff_id, service_id, location_id,
            start_at, end_at, occupied_start_at, occupied_end_at, status, source
     FROM appointments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0];
}

export async function updateAppointmentSchedule(
  client: PoolClient,
  tenantId: string,
  id: string,
  times: { startAt: Date; endAt: Date; occupiedStartAt: Date; occupiedEndAt: Date },
) {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments SET
       start_at = $3, end_at = $4, occupied_start_at = $5, occupied_end_at = $6, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'CONFIRMED'
     RETURNING id, tenant_id, customer_id, staff_id, service_id, location_id,
               start_at, end_at, occupied_start_at, occupied_end_at, status, source`,
    [tenantId, id, times.startAt, times.endAt, times.occupiedStartAt, times.occupiedEndAt],
  );
  return r.rows[0];
}

export async function cancelAppointment(client: PoolClient, tenantId: string, id: string) {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments SET status = 'CANCELLED', updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'CONFIRMED'
     RETURNING id, tenant_id, customer_id, staff_id, service_id, location_id,
               start_at, end_at, occupied_start_at, occupied_end_at, status, source`,
    [tenantId, id],
  );
  return r.rows[0];
}

export async function insertAudit(
  client: PoolClient,
  tenantId: string,
  input: {
    actorType: string;
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, object_type, object_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      tenantId,
      input.actorType,
      input.actorId,
      input.action,
      input.objectType,
      input.objectId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
