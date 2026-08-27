import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { DateTime } from "luxon";
import {
  applyMigrations,
  customerHasAppointmentHistory,
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

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const hmac = { "1": "aa".repeat(32) };
const enc = { "1": "bb".repeat(32) };
const phones = {
  hmacKeyring: parseKeyring(JSON.stringify(hmac)),
  encryptionKeyring: parseKeyring(JSON.stringify(enc)),
  hmacWriteVersion: 1,
  encryptionWriteVersion: 1,
};

function local(iso: string): Date {
  return DateTime.fromISO(iso, { zone: "Asia/Jerusalem" }).toUTC().toJSDate();
}

function hourInTz(d: Date): number {
  return DateTime.fromJSDate(d, { zone: "utc" }).setZone("Asia/Jerusalem").hour;
}

describe("owner schedule, manual booking, blocked time", () => {
  let pg: EphemeralPg;
  let pool: Pool;
  let catalog: CatalogService;
  let appointments: AppointmentService;
  let scheduling: SchedulingService;
  let danielId: string;
  let gilId: string;
  let cutId: string;
  let staffBId: string;
  let cutBId: string;
  const ctxA: TrustedTenantContext = { tenantId: TENANT_A, actorType: "OWNER", actorId: "owner-a" };
  const ctxB: TrustedTenantContext = { tenantId: TENANT_B, actorType: "OWNER", actorId: "owner-b" };
  const clock = { now: () => new Date("2026-08-25T08:00:00.000Z") };

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await applyMigrations(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO businesses (id, name, timezone) VALUES ($1,'A','Asia/Jerusalem'), ($2,'B','Asia/Jerusalem')`,
      [TENANT_A, TENANT_B],
    );
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 8 });
    scheduling = new SchedulingService(pool, clock);
    catalog = new CatalogService(pool);
    appointments = new AppointmentService(pool, scheduling, phones);

    const daniel = await catalog.createStaff(ctxA, "Daniel");
    const gil = await catalog.createStaff(ctxA, "Gil");
    const cut = await catalog.createService(ctxA, {
      name: "תספורת",
      durationMinutes: 30,
      priceMinor: 8000,
    });
    await catalog.assignService(ctxA, daniel.id, cut.id);
    await catalog.assignService(ctxA, gil.id, cut.id);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 0, [{ startTime: "09:00", endTime: "19:00" }]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 1, [{ startTime: "09:00", endTime: "19:00" }]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 2, [{ startTime: "10:00", endTime: "20:00" }]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 3, [
      { startTime: "09:00", endTime: "12:00" },
      { startTime: "14:00", endTime: "19:00" },
    ]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 4, [{ startTime: "12:00", endTime: "21:00" }]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 5, [{ startTime: "08:00", endTime: "14:00" }]);
    await catalog.setWorkingDayHours(ctxA, daniel.id, 6, []);
    for (const dow of [0, 1, 2, 3, 4]) {
      await catalog.setWorkingHours(ctxA, gil.id, dow, "14:00", "21:00");
    }
    const staffB = await catalog.createStaff(ctxB, "Other");
    const cutB = await catalog.createService(ctxB, {
      name: "תספורת",
      durationMinutes: 30,
      priceMinor: 1,
    });
    await catalog.assignService(ctxB, staffB.id, cutB.id);
    await catalog.setWorkingHours(ctxB, staffB.id, 3, "09:00", "19:00");
    danielId = daniel.id;
    gilId = gil.id;
    cutId = cut.id;
    staffBId = staffB.id;
    cutBId = cutB.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await pg.stop();
  });

  it("applies weekly hours, closed weekdays, multi-range days, exceptions, breaks, and time off", async () => {
    const tue = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-09-01T00:00"),
      to: local("2026-09-02T00:00"),
    });
    expect(tue.length).toBeGreaterThan(0);
    expect(tue.every((s) => hourInTz(s.startAt) >= 10 && hourInTz(s.startAt) < 20)).toBe(true);

    const wed = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-08-26T00:00"),
      to: local("2026-08-27T00:00"),
    });
    expect(wed.some((s) => hourInTz(s.startAt) === 11)).toBe(true);
    expect(wed.some((s) => hourInTz(s.startAt) === 12 || hourInTz(s.startAt) === 13)).toBe(false);
    expect(wed.some((s) => hourInTz(s.startAt) === 14)).toBe(true);

    const fri = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-08-28T00:00"),
      to: local("2026-08-29T00:00"),
    });
    expect(fri.length).toBeGreaterThan(0);
    expect(fri.every((s) => hourInTz(s.startAt) < 14)).toBe(true);

    const sat = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-08-29T00:00"),
      to: local("2026-08-30T00:00"),
    });
    expect(sat).toEqual([]);

    await catalog.setDateException(ctxA, danielId, "2026-09-03", { kind: "CLOSED" });
    const closed = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-09-03T00:00"),
      to: local("2026-09-04T00:00"),
    });
    expect(closed).toEqual([]);
    const gilThatDay = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: gilId,
      from: local("2026-09-03T00:00"),
      to: local("2026-09-04T00:00"),
    });
    expect(gilThatDay.length).toBeGreaterThan(0);

    await catalog.setDateException(ctxA, danielId, "2026-09-08", {
      kind: "OPEN",
      ranges: [{ startTime: "14:00", endTime: "18:00" }],
    });
    const special = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-09-08T00:00"),
      to: local("2026-09-09T00:00"),
    });
    expect(special.length).toBeGreaterThan(0);
    expect(special.every((s) => hourInTz(s.startAt) >= 14 && hourInTz(s.startAt) < 18)).toBe(true);

    await catalog.addBreak(ctxA, danielId, local("2026-09-07T12:00"), local("2026-09-07T13:00"));
    const mon = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-09-07T00:00"),
      to: local("2026-09-08T00:00"),
    });
    expect(mon.some((s) => hourInTz(s.startAt) === 12)).toBe(false);
    expect(mon.some((s) => hourInTz(s.startAt) === 11)).toBe(true);

    await catalog.addTimeOff(ctxA, danielId, local("2026-08-27T12:00"), local("2026-08-27T21:00"), "vacation");
    const thu = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-08-27T00:00"),
      to: local("2026-08-28T00:00"),
    });
    expect(thu).toEqual([]);
    const gilThu = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: gilId,
      from: local("2026-08-27T00:00"),
      to: local("2026-08-28T00:00"),
    });
    expect(gilThu.length).toBeGreaterThan(0);
  });

  it("creates a phone-booked customer appointment that occupies the same GiST as Tavo", async () => {
    const startAt = local("2026-08-31T17:00");
    const created = await appointments.create(ctxA, {
      staffId: danielId,
      serviceId: cutId,
      startAt,
      customerPhone: "0501112233",
      customerName: "יוסי כהן",
      source: "PHONE",
    });
    expect(created.source).toBe("PHONE");
    expect(created.customer_id).toBeTruthy();
    const again = await appointments.create(ctxA, {
      staffId: danielId,
      serviceId: cutId,
      startAt: local("2026-08-31T18:00"),
      customerPhone: "0501112233",
      customerName: "יוסי כהן",
      source: "WALK_IN",
    });
    expect(again.customer_id).toBe(created.customer_id);
    const slots = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-08-31T16:30"),
      to: local("2026-08-31T17:30"),
    });
    expect(slots.some((s) => s.startAt.getTime() === startAt.getTime())).toBe(false);
    await expect(
      appointments.create(ctxA, {
        staffId: danielId,
        serviceId: cutId,
        startAt,
        customerPhone: "0509998877",
        source: "MANUAL",
      }),
    ).rejects.toMatchObject({ code: "SLOT_NO_LONGER_AVAILABLE" });
    const history = await withTenant(pool, TENANT_A, (c) =>
      customerHasAppointmentHistory(c, TENANT_A, created.customer_id!),
    );
    expect(history).toBe(true);
    const plaintext = await withTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ phone_encrypted: string }>(
        `SELECT phone_encrypted FROM customers WHERE id = $1`,
        [created.customer_id],
      );
      return r.rows[0]!.phone_encrypted;
    });
    expect(plaintext).not.toContain("0501112233");
    expect(plaintext).not.toContain("972501112233");
    const asB = await withTenant(pool, TENANT_B, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments`);
      return r.rows[0]!.n;
    });
    expect(asB).toBe(0);
    const moved = await appointments.reschedule(ctxA, created.id, local("2026-08-31T16:00"));
    expect(moved.start_at.getTime()).toBe(local("2026-08-31T16:00").getTime());
    const cancelled = await appointments.cancel(ctxA, created.id);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("serializes concurrent manual and Tavo-path creates on the same occupancy", async () => {
    const startAt = local("2026-09-02T11:00");
    const raced = await Promise.allSettled([
      appointments.create(ctxA, {
        staffId: danielId,
        serviceId: cutId,
        startAt,
        customerPhone: "0504445566",
        source: "MANUAL",
      }),
      appointments.create(ctxA, {
        staffId: danielId,
        serviceId: cutId,
        startAt,
        customerPhone: "0504445577",
        source: "HARNESS",
      }),
    ]);
    const ok = raced.filter((r) => r.status === "fulfilled");
    const bad = raced.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "SLOT_NO_LONGER_AVAILABLE",
    });
  });

  it("blocks time without a customer and hides the internal reason from occupancy queries", async () => {
    const before = await withTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers`);
      return r.rows[0]!.n;
    });
    const startAt = local("2026-09-01T17:00");
    const blocked = await appointments.blockTime(ctxA, {
      staffId: danielId,
      startAt,
      endAt: local("2026-09-01T18:00"),
      internalNote: "personal errand",
    });
    expect(blocked.source).toBe("BLOCKED");
    expect(blocked.customer_id).toBeNull();
    const after = await withTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers`);
      return r.rows[0]!.n;
    });
    expect(after).toBe(before);
    const slots = await scheduling.findAvailableSlots(ctxA, {
      serviceId: cutId,
      staffId: danielId,
      from: local("2026-09-01T16:30"),
      to: local("2026-09-01T18:30"),
    });
    expect(slots.some((s) => s.startAt.getTime() === startAt.getTime())).toBe(false);
    const audit = await withTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'occupancy.blocked' AND object_id = $1`,
        [blocked.id],
      );
      return JSON.stringify(r.rows[0]?.metadata ?? {});
    });
    expect(audit).not.toContain("personal errand");
    expect(audit).toContain(danielId);
    await expect(
      appointments.create(ctxB, {
        staffId: danielId,
        serviceId: cutId,
        startAt: local("2026-09-02T17:00"),
        customerPhone: "0502223344",
        source: "MANUAL",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const bOwn = await appointments.create(ctxB, {
      staffId: staffBId,
      serviceId: cutBId,
      startAt: local("2026-08-26T10:00"),
      customerPhone: "0502223344",
      source: "MANUAL",
    });
    await expect(appointments.get(ctxA, bOwn.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects inventing a customer without a phone and rejects WhatsApp source on the owner path", async () => {
    await expect(
      appointments.create(ctxA, {
        staffId: danielId,
        serviceId: cutId,
        startAt: local("2026-09-02T10:00"),
        customerPhone: "",
        source: "MANUAL",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      appointments.create(ctxA, {
        staffId: danielId,
        serviceId: cutId,
        startAt: local("2026-09-02T10:00"),
        customerPhone: "0503334455",
        source: "WHATSAPP",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
