import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  bootstrapRolesAndSchema,
  startEphemeralPostgres,
  waitForPg,
  type EphemeralPg,
} from "@tavo/database";
import { buildApp } from "./app";
import type { AppConfig } from "./config";
import { parseKeyring } from "@tavo/security";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const KEY_A = "key-a";
const KEY_B = "key-b";

describe("api harness", () => {
  let pg: EphemeralPg;
  let pool: Pool;
  let appA: ReturnType<typeof buildApp>;
  let appB: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    await waitForPg(pg.superuserUrl);
    await bootstrapRolesAndSchema(pg.superuserUrl);
    const admin = new Client({ connectionString: pg.migratorUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO businesses (id, name, timezone) VALUES ($1,'A','Asia/Jerusalem'), ($2,'B','Asia/Jerusalem')`,
      [TENANT_A, TENANT_B],
    );
    await admin.end();
    pool = new Pool({ connectionString: pg.appUrl, max: 4 });
    const phones = {
      hmacKeyring: parseKeyring(JSON.stringify({ "1": "cc".repeat(32) })),
      encryptionKeyring: parseKeyring(JSON.stringify({ "1": "dd".repeat(32) })),
      hmacWriteVersion: 1,
      encryptionWriteVersion: 1,
    };
    const meta = {
      appSecret: "meta-secret-value",
      verifyToken: "verify-token-value",
      routingHmacKey: Buffer.from("ee".repeat(32), "hex"),
      messages: {
        encryptionKeyring: parseKeyring(JSON.stringify({ "1": "ff".repeat(32) })),
        writeVersion: 1,
      },
    };
    const base: Omit<AppConfig, "apiKeys"> = { databaseUrl: pg.appUrl, phones, meta };
    const clock = { now: () => new Date("2026-08-25T08:00:00.000Z") };
    appA = buildApp({ ...base, apiKeys: new Map([[KEY_A, TENANT_A]]) }, pool, clock);
    appB = buildApp({ ...base, apiKeys: new Map([[KEY_B, TENANT_B]]) }, pool, clock);
    await appA.ready();
    await appB.ready();
  }, 60_000);

  afterAll(async () => {
    await appA.close();
    await appB.close();
    await pool.end();
    await pg.stop();
  });

  it("rejects missing bearer token", async () => {
    const res = await appA.inject({ method: "GET", url: "/v1/appointments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    expect(res.statusCode).toBe(401);
  });

  it("binds tenant from the credential, ignoring tenant_id in the body", async () => {
    const staff = await appA.inject({
      method: "POST",
      url: "/v1/staff",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: { name: "Daniel" },
    });
    expect(staff.statusCode).toBe(200);
    const staffId = staff.json().id as string;
    const service = await appA.inject({
      method: "POST",
      url: "/v1/services",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: { name: "Haircut", durationMinutes: 30, priceMinor: 9000, bufferAfterMinutes: 5 },
    });
    const serviceId = service.json().id as string;
    await appA.inject({
      method: "POST",
      url: `/v1/staff/${staffId}/services`,
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: { serviceId },
    });
    await appA.inject({
      method: "POST",
      url: `/v1/staff/${staffId}/working-hours`,
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: { dayOfWeek: 0, startTime: "09:00", endTime: "19:00" },
    });

    const avail = await appA.inject({
      method: "POST",
      url: "/v1/availability",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "x-tenant-id": TENANT_B,
      },
      payload: {
        tenant_id: TENANT_B,
        serviceId,
        staffId,
        from: "2026-08-30T00:00:00.000Z",
        to: "2026-08-30T20:00:00.000Z",
      },
    });
    expect(avail.statusCode).toBe(200);
    expect(avail.json().slots.length).toBeGreaterThan(0);

    const foreign = await appB.inject({
      method: "GET",
      url: `/v1/appointments/${staffId}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(foreign.statusCode).toBe(404);

    const slot = avail.json().slots[0] as { startAt: string };
    const booked = await appA.inject({
      method: "POST",
      url: "/v1/appointments",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: {
        staffId,
        serviceId,
        startAt: slot.startAt,
        customerPhone: "0501234567",
        customerName: "Dan",
        tenant_id: TENANT_B,
      },
    });
    expect(booked.statusCode).toBe(200);
    expect(booked.json().status).toBe("CONFIRMED");
    const appointmentId = booked.json().id as string;

    const asB = await appB.inject({
      method: "GET",
      url: `/v1/appointments/${appointmentId}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(asB.statusCode).toBe(404);

    const cancelled = await appA.inject({
      method: "POST",
      url: `/v1/appointments/${appointmentId}/cancel`,
      headers: { authorization: `Bearer ${KEY_A}` },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("CANCELLED");

    const offGrid = await appA.inject({
      method: "POST",
      url: "/v1/appointments",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: {
        staffId,
        serviceId,
        startAt: "2026-08-30T06:07:00.000Z",
        customerPhone: "0507654321",
      },
    });
    expect(offGrid.statusCode).toBe(400);
    expect(offGrid.json().error.code).toBe("VALIDATION");

    const beyond = await appA.inject({
      method: "POST",
      url: "/v1/appointments",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: {
        staffId,
        serviceId,
        startAt: "2026-09-24T06:00:00.000Z",
        customerPhone: "0507654322",
      },
    });
    expect(beyond.statusCode).toBe(400);
    expect(beyond.json().error.code).toBe("VALIDATION");
  });
});
