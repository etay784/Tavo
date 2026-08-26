import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Client } from "pg";
import {
  bootstrapRolesAndSchema,
  listWorkingHours,
  startEphemeralPostgres,
  waitForPg,
  withTenant,
  type EphemeralPg,
} from "@tavo/database";
import { parseKeyring } from "@tavo/security";
import type { TrustedTenantContext } from "@tavo/shared";
import { AppointmentService } from "./appointment-service";
import { CatalogService } from "./catalog-service";
import { SchedulingService } from "./scheduling-service";

const TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const hmac = { "1": "aa".repeat(32) };
const enc = { "1": "bb".repeat(32) };

describe("booking integration", () => {
  let pg: EphemeralPg;
  let pool: Pool;
  let ctx: TrustedTenantContext;
  let catalog: CatalogService;
  let appointments: AppointmentService;
  let scheduling: SchedulingService;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await bootstrapRolesAndSchema(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO businesses (id, name, timezone) VALUES ($1,'Pilot','Asia/Jerusalem')`,
      [TENANT],
    );
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 4 });
    ctx = { tenantId: TENANT, actorType: "TEST", actorId: "vitest" };
    const phones = {
      hmacKeyring: parseKeyring(JSON.stringify(hmac)),
      encryptionKeyring: parseKeyring(JSON.stringify(enc)),
      hmacWriteVersion: 1,
      encryptionWriteVersion: 1,
    };
    const clock = { now: () => new Date("2026-08-25T08:00:00.000Z") };
    scheduling = new SchedulingService(pool, clock);
    catalog = new CatalogService(pool);
    appointments = new AppointmentService(pool, scheduling, phones);
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await pg.stop();
  });

  it("creates, lists availability, reschedules, cancels, and serializes double-book", async () => {
    const staff = await catalog.createStaff(ctx, "Daniel");
    const service = await catalog.createService(ctx, {
      name: "Haircut",
      durationMinutes: 30,
      priceMinor: 9000,
      bufferAfterMinutes: 5,
    });
    await catalog.assignService(ctx, staff.id, service.id);
    for (const dow of [0, 1, 2, 3, 4]) {
      await catalog.setWorkingHours(ctx, staff.id, dow, "09:00", "19:00");
    }

    const slots = await scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      staffId: staff.id,
      from: new Date("2026-08-27T00:00:00.000Z"),
      to: new Date("2026-08-27T21:00:00.000Z"),
    });
    expect(slots.length).toBeGreaterThan(0);
    const startAt = slots[3]!.startAt;

    const created = await appointments.create(ctx, {
      staffId: staff.id,
      serviceId: service.id,
      startAt,
      customerPhone: "0501234567",
      customerName: "Dan",
      source: "HARNESS",
    });
    expect(created.status).toBe("CONFIRMED");
    expect(created.occupied_end_at.getTime()).toBeGreaterThan(created.end_at.getTime());

    const later = slots[8]!.startAt;
    const moved = await appointments.reschedule(ctx, created.id, later);
    expect(moved.start_at.getTime()).toBe(later.getTime());

    const raceStart = slots[10]!.startAt;
    await appointments.cancel(ctx, created.id);
    const raced = await Promise.allSettled([
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: raceStart,
        customerPhone: "+972509999999",
      }),
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: raceStart,
        customerPhone: "+972508888888",
      }),
    ]);
    const ok = raced.filter((r) => r.status === "fulfilled");
    const bad = raced.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "SLOT_NO_LONGER_AVAILABLE",
    });

    const hmacV2 = {
      hmacKeyring: parseKeyring(
        JSON.stringify({ "1": "aa".repeat(32), "2": "ee".repeat(32) }),
      ),
      encryptionKeyring: parseKeyring(JSON.stringify(enc)),
      hmacWriteVersion: 2,
      encryptionWriteVersion: 1,
    };
    const appointmentsV2 = new AppointmentService(pool, scheduling, hmacV2);
    const freeAgain = await scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      staffId: staff.id,
      from: new Date("2026-08-27T00:00:00.000Z"),
      to: new Date("2026-08-27T21:00:00.000Z"),
    });
    expect(freeAgain.length).toBeGreaterThan(0);
    const samePerson = await appointmentsV2.create(ctx, {
      staffId: staff.id,
      serviceId: service.id,
      startAt: freeAgain[0]!.startAt,
      customerPhone: "0501234567",
    });
    const first = await appointments.get(ctx, created.id);
    expect(samePerson.customer_id).toBe(first.customer_id);
  });

  it("rejects off-grid starts and starts beyond the booking horizon on create and reschedule", async () => {
    const staff = await catalog.createStaff(ctx, "Grid");
    const service = await catalog.createService(ctx, {
      name: "Grid cut",
      durationMinutes: 30,
      priceMinor: 1,
    });
    await catalog.assignService(ctx, staff.id, service.id);
    for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
      await catalog.setWorkingHours(ctx, staff.id, dow, "09:00", "19:00");
    }

    const offGrid = new Date("2026-08-27T06:07:00.000Z");
    await expect(
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: offGrid,
        customerPhone: "+972501070707",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const beyondHorizon = new Date("2026-09-23T06:00:00.000Z");
    await expect(
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: beyondHorizon,
        customerPhone: "+972501070708",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const slots = await scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      staffId: staff.id,
      from: new Date("2026-08-27T00:00:00.000Z"),
      to: new Date("2026-08-27T21:00:00.000Z"),
    });
    const booked = await appointments.create(ctx, {
      staffId: staff.id,
      serviceId: service.id,
      startAt: slots[0]!.startAt,
      customerPhone: "+972501070709",
    });
    await expect(appointments.reschedule(ctx, booked.id, offGrid)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(appointments.reschedule(ctx, booked.id, beyondHorizon)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const still = await appointments.get(ctx, booked.id);
    expect(still.status).toBe("CONFIRMED");
    expect(still.start_at.getTime()).toBe(slots[0]!.startAt.getTime());
  });

  it("upserts the same new phone under concurrent creates", async () => {
    const staff = await catalog.createStaff(ctx, "Race");
    const service = await catalog.createService(ctx, {
      name: "Race cut",
      durationMinutes: 30,
      priceMinor: 1,
    });
    await catalog.assignService(ctx, staff.id, service.id);
    for (const dow of [0, 1, 2, 3, 4]) {
      await catalog.setWorkingHours(ctx, staff.id, dow, "09:00", "19:00");
    }
    const slots = await scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      staffId: staff.id,
      from: new Date("2026-08-27T00:00:00.000Z"),
      to: new Date("2026-08-27T21:00:00.000Z"),
    });
    const phone = "+972507070001";
    const raced = await Promise.allSettled([
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: slots[0]!.startAt,
        customerPhone: phone,
        customerName: "A",
      }),
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: slots[2]!.startAt,
        customerPhone: phone,
        customerName: "B",
      }),
    ]);
    const ok = raced.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      customer_id: string;
    }>[];
    expect(raced.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(ok).toHaveLength(2);
    expect(ok[0]!.value.customer_id).toBe(ok[1]!.value.customer_id);
  });

  it("sets working hours via tenant-scoped upsert and records catalog audits", async () => {
    const staff = await catalog.createStaff(ctx, "Hours");
    const service = await catalog.createService(ctx, {
      name: "Hours cut",
      durationMinutes: 30,
      priceMinor: 1,
    });
    await catalog.assignService(ctx, staff.id, service.id);
    await catalog.setWorkingHours(ctx, staff.id, 4, "09:00", "19:00");
    await catalog.setWorkingHours(ctx, staff.id, 4, "10:00", "18:00");
    const hours = await withTenant(pool, TENANT, (client) =>
      listWorkingHours(client, TENANT, staff.id),
    );
    const thu = hours.find((h) => Number(h.day_of_week) === 4);
    expect(thu?.start_time).toMatch(/^10:00/);
    expect(thu?.end_time).toMatch(/^18:00/);

    await catalog.addBreak(
      ctx,
      staff.id,
      new Date("2026-08-27T10:00:00.000Z"),
      new Date("2026-08-27T10:15:00.000Z"),
    );
    await catalog.addTimeOff(
      ctx,
      staff.id,
      new Date("2026-08-28T00:00:00.000Z"),
      new Date("2026-08-28T23:00:00.000Z"),
    );

    const actions = await withTenant(pool, TENANT, async (client) => {
      const r = await client.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_events WHERE tenant_id = $1`,
        [TENANT],
      );
      return r.rows.map((x) => x.action);
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        "staff.created",
        "service.created",
        "staff_service.assigned",
        "working_hours.set",
        "break.created",
        "time_off.created",
      ]),
    );
  });

  it("rejects create and reschedule when the staff no longer offers the service", async () => {
    const staff = await catalog.createStaff(ctx, "Elig");
    const service = await catalog.createService(ctx, {
      name: "Elig cut",
      durationMinutes: 30,
      priceMinor: 1,
    });
    await catalog.assignService(ctx, staff.id, service.id);
    for (const dow of [0, 1, 2, 3, 4]) {
      await catalog.setWorkingHours(ctx, staff.id, dow, "09:00", "19:00");
    }
    const slots = await scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      staffId: staff.id,
      from: new Date("2026-08-27T00:00:00.000Z"),
      to: new Date("2026-08-27T21:00:00.000Z"),
    });
    const booked = await appointments.create(ctx, {
      staffId: staff.id,
      serviceId: service.id,
      startAt: slots[0]!.startAt,
      customerPhone: "+972507070099",
    });
    await withTenant(pool, TENANT, async (client) => {
      await client.query(
        `UPDATE staff_services SET active = false WHERE tenant_id = $1 AND staff_id = $2`,
        [TENANT, staff.id],
      );
    });
    await expect(
      appointments.create(ctx, {
        staffId: staff.id,
        serviceId: service.id,
        startAt: slots[1]!.startAt,
        customerPhone: "+972507070098",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      appointments.reschedule(ctx, booked.id, slots[1]!.startAt),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const existing = await appointments.get(ctx, booked.id);
    expect(existing.status).toBe("CONFIRMED");
  });
});
