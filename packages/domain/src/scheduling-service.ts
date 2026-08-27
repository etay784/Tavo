import type { Pool, PoolClient } from "pg";
import type { Clock, TrustedTenantContext } from "@tavo/shared";
import { Errors, addMinutes } from "@tavo/shared";
import {
  getBusiness,
  getService,
  getStaff,
  listBreaks,
  listEligibleStaff,
  listOccupied,
  listScheduleExceptions,
  listTimeOff,
  listWorkingHours,
  staffOffersService,
  withTenant,
} from "@tavo/database";
import {
  candidateStarts,
  isOnCivilGrid,
  occupancySnapshot,
  slotFits,
  subtractBusy,
  type Interval,
} from "./occupancy";
import { eachCivilDate, localWorkWindow, weekdaySunday0 } from "./civil-time";
import { DateTime } from "luxon";

export class SchedulingService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async findAvailableSlots(
    ctx: TrustedTenantContext,
    input: { serviceId: string; staffId?: string; from: Date; to: Date },
  ) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const business = await getBusiness(client, ctx.tenantId);
      if (!business) throw Errors.notFound("business");
      const service = await getService(client, ctx.tenantId, input.serviceId);
      if (!service || !service.active) throw Errors.notFound("service");
      let staff = await listEligibleStaff(client, ctx.tenantId, input.serviceId);
      if (input.staffId) {
        staff = staff.filter((s) => s.id === input.staffId);
        if (staff.length === 0) throw Errors.notFound("staff");
      }
      const now = this.clock.now();
      const minStart = addMinutes(now, business.min_advance_minutes);
      const horizonEnd = addMinutes(now, business.booking_horizon_days * 24 * 60);
      const rangeFrom = input.from < minStart ? minStart : input.from;
      const rangeTo = input.to < horizonEnd ? input.to : horizonEnd;
      if (rangeTo <= rangeFrom) return [];

      const results: { staffId: string; staffName: string; startAt: Date }[] = [];
      for (const member of staff) {
        const free = await this.freeWindows(
          client,
          ctx.tenantId,
          member.id,
          business.timezone,
          rangeFrom,
          rangeTo,
        );
        const starts = candidateStarts(
          free,
          service.duration_minutes,
          service.buffer_before_minutes,
          service.buffer_after_minutes,
          business.slot_granularity_minutes,
          business.timezone,
        );
        for (const startAt of starts) {
          if (startAt < minStart || startAt >= rangeTo) continue;
          results.push({ staffId: member.id, staffName: member.name, startAt });
        }
      }
      results.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      return results;
    });
  }

  async assertSlotAvailable(
    ctx: TrustedTenantContext,
    input: {
      serviceId: string;
      staffId: string;
      startAt: Date;
      exceptAppointmentId?: string;
    },
  ) {
    return withTenant(this.pool, ctx.tenantId, (client) =>
      this.assertSlotAvailableOnClient(client, ctx, input),
    );
  }

  async assertSlotAvailableOnClient(
    client: PoolClient,
    ctx: TrustedTenantContext,
    input: {
      serviceId: string;
      staffId: string;
      startAt: Date;
      exceptAppointmentId?: string;
    },
  ) {
    const business = await getBusiness(client, ctx.tenantId);
    if (!business) throw Errors.notFound("business");
    const service = await getService(client, ctx.tenantId, input.serviceId);
    if (!service || !service.active) throw Errors.notFound("service");
    const staff = await getStaff(client, ctx.tenantId, input.staffId);
    if (!staff || !staff.active) throw Errors.notFound("staff");
    const eligible = await staffOffersService(
      client,
      ctx.tenantId,
      input.staffId,
      input.serviceId,
    );
    if (!eligible) {
      throw Errors.validation("staff does not offer this service");
    }
    if (!isOnCivilGrid(input.startAt, business.slot_granularity_minutes, business.timezone)) {
      throw Errors.validation("start is not aligned to the configured slot grid");
    }
    const now = this.clock.now();
    if (input.startAt < addMinutes(now, business.min_advance_minutes)) {
      throw Errors.validation("start is inside the minimum advance notice");
    }
    if (input.startAt >= addMinutes(now, business.booking_horizon_days * 24 * 60)) {
      throw Errors.validation("start is beyond the booking horizon");
    }
    const occ = occupancySnapshot(
      input.startAt,
      service.duration_minutes,
      service.buffer_before_minutes,
      service.buffer_after_minutes,
    );
    const padFrom = addMinutes(occ.occupiedStartAt, -1);
    const padTo = addMinutes(occ.occupiedEndAt, 1);
    const free = await this.freeWindows(
      client,
      ctx.tenantId,
      input.staffId,
      business.timezone,
      padFrom,
      padTo,
      input.exceptAppointmentId,
    );
    if (
      !slotFits(free, {
        start: occ.occupiedStartAt,
        end: occ.occupiedEndAt,
      })
    ) {
      throw Errors.slotNoLongerAvailable();
    }
    return { business, service, occupancy: occ };
  }

  private async freeWindows(
    client: PoolClient,
    tenantId: string,
    staffId: string,
    timeZone: string,
    from: Date,
    to: Date,
    exceptAppointmentId?: string,
  ): Promise<Interval[]> {
    const hours = await listWorkingHours(client, tenantId, staffId);
    const dates = eachCivilDate(from, to, timeZone);
    const fromCivil = dates[0];
    const toCivil = dates[dates.length - 1];
    const exceptions =
      fromCivil && toCivil
        ? await listScheduleExceptions(client, tenantId, staffId, fromCivil, toCivil)
        : [];
    const work: Interval[] = [];
    for (const iso of dates) {
      const dayEx = exceptions.filter((e) => e.civil_date === iso);
      if (dayEx.some((e) => e.kind === "CLOSED")) continue;
      const opens = dayEx.filter((e) => e.kind === "OPEN" && e.start_time && e.end_time);
      if (opens.length > 0) {
        for (const row of opens) {
          work.push(localWorkWindow(iso, row.start_time!, row.end_time!, timeZone));
        }
        continue;
      }
      const dt = DateTime.fromISO(iso, { zone: timeZone });
      const dow = weekdaySunday0(dt);
      const rows = hours.filter((h) => Number(h.day_of_week) === dow);
      for (const row of rows) {
        work.push(localWorkWindow(iso, row.start_time, row.end_time, timeZone));
      }
    }
    const busyRows = [
      ...(await listBreaks(client, tenantId, staffId, from, to)),
      ...(await listTimeOff(client, tenantId, staffId, from, to)),
    ].map((r) => ({ start: r.starts_at, end: r.ends_at }));
    const occupied = await listOccupied(
      client,
      tenantId,
      staffId,
      from,
      to,
      exceptAppointmentId,
    );
    const busy: Interval[] = [
      ...busyRows,
      ...occupied.map((o) => ({
        start: o.occupied_start_at,
        end: o.occupied_end_at,
      })),
    ];
    const free: Interval[] = [];
    for (const w of work) {
      const clipped = {
        start: w.start < from ? from : w.start,
        end: w.end > to ? to : w.end,
      };
      if (clipped.end <= clipped.start) continue;
      free.push(...subtractBusy(clipped, busy));
    }
    return free;
  }
}
