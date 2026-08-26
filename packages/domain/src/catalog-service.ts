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

  async addTimeOff(ctx: TrustedTenantContext, staffId: string, startsAt: Date, endsAt: Date) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await insertTimeOff(client, ctx.tenantId, staffId, startsAt, endsAt);
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
}
