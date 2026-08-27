import type { Pool } from "pg";
import type { TrustedTenantContext } from "@tavo/shared";
import { Errors } from "@tavo/shared";
import {
  insertAudit,
  insertBreak,
  insertService,
  insertStaff,
  insertStaffService,
  insertTimeOff,
  insertWorkingHours,
  replaceScheduleExceptionsForDate,
  replaceWorkingHoursForDay,
  withTenant,
} from "@tavo/database";

export class CatalogService {
  constructor(private readonly pool: Pool) {}

  async createStaff(ctx: TrustedTenantContext, name: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertStaff(client, ctx.tenantId, name, null);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "staff.created",
        objectType: "staff",
        objectId: row.id,
      });
      return row;
    });
  }

  async createService(
    ctx: TrustedTenantContext,
    input: {
      name: string;
      durationMinutes: number;
      priceMinor: number;
      bufferBeforeMinutes?: number;
      bufferAfterMinutes?: number;
    },
  ) {
    if (input.durationMinutes <= 0) throw Errors.validation("duration");
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertService(client, ctx.tenantId, {
        name: input.name,
        durationMinutes: input.durationMinutes,
        priceMinor: input.priceMinor,
        bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
      });
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "service.created",
        objectType: "service",
        objectId: row.id,
      });
      return row;
    });
  }

  async assignService(ctx: TrustedTenantContext, staffId: string, serviceId: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertStaffService(client, ctx.tenantId, staffId, serviceId);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "staff_service.assigned",
        objectType: "staff_service",
        objectId: row.id,
        metadata: { staffId, serviceId },
      });
      return row;
    });
  }

  async setWorkingHours(
    ctx: TrustedTenantContext,
    staffId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
  ) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertWorkingHours(client, ctx.tenantId, staffId, dayOfWeek, startTime, endTime);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "working_hours.set",
        objectType: "working_hours",
        objectId: row.id,
        metadata: { staffId, dayOfWeek },
      });
      return row;
    });
  }

  async addBreak(ctx: TrustedTenantContext, staffId: string, startsAt: Date, endsAt: Date) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertBreak(client, ctx.tenantId, staffId, startsAt, endsAt);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "break.created",
        objectType: "break",
        objectId: row.id,
        metadata: { staffId },
      });
      return row;
    });
  }

  async addTimeOff(
    ctx: TrustedTenantContext,
    staffId: string,
    startsAt: Date,
    endsAt: Date,
    reasonOptional?: string,
  ) {
    if (!(startsAt < endsAt)) throw Errors.validation("time off range");
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertTimeOff(client, ctx.tenantId, staffId, startsAt, endsAt, reasonOptional ?? null);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "time_off.created",
        objectType: "time_off",
        objectId: row.id,
        metadata: { staffId },
      });
      return row;
    });
  }

  async setWorkingDayHours(
    ctx: TrustedTenantContext,
    staffId: string,
    dayOfWeek: number,
    ranges: { startTime: string; endTime: string }[],
  ) {
    if (dayOfWeek < 0 || dayOfWeek > 6) throw Errors.validation("dayOfWeek");
    for (const r of ranges) {
      if (r.startTime >= r.endTime) throw Errors.validation("working range");
    }
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const rows = await replaceWorkingHoursForDay(client, ctx.tenantId, staffId, dayOfWeek, ranges);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "working_hours.set",
        objectType: "working_hours",
        objectId: staffId,
        metadata: { staffId, dayOfWeek, rangeCount: ranges.length },
      });
      return rows;
    });
  }

  async setDateException(
    ctx: TrustedTenantContext,
    staffId: string,
    civilDate: string,
    spec: { kind: "CLOSED" } | { kind: "OPEN"; ranges: { startTime: string; endTime: string }[] },
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) throw Errors.validation("civilDate");
    const rows =
      spec.kind === "CLOSED"
        ? [{ kind: "CLOSED" as const }]
        : spec.ranges.map((r) => {
            if (r.startTime >= r.endTime) throw Errors.validation("exception range");
            return { kind: "OPEN" as const, startTime: r.startTime, endTime: r.endTime };
          });
    if (spec.kind === "OPEN" && spec.ranges.length === 0) {
      throw Errors.validation("exception ranges");
    }
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const inserted = await replaceScheduleExceptionsForDate(
        client,
        ctx.tenantId,
        staffId,
        civilDate,
        rows,
      );
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "schedule_exception.set",
        objectType: "staff_schedule_exception",
        objectId: staffId,
        metadata: { staffId, civilDate, kind: spec.kind, rangeCount: inserted.length },
      });
      return inserted;
    });
  }

  async clearDateException(ctx: TrustedTenantContext, staffId: string, civilDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) throw Errors.validation("civilDate");
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      await replaceScheduleExceptionsForDate(client, ctx.tenantId, staffId, civilDate, []);
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "schedule_exception.cleared",
        objectType: "staff_schedule_exception",
        objectId: staffId,
        metadata: { staffId, civilDate },
      });
    });
  }
}
