import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Client } from "pg";
import {
  bootstrapRolesAndSchema,
  startEphemeralPostgres,
  waitForPg,
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
});
