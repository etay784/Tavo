import type { Pool } from "pg";
import type { PoolClient } from "pg";
import type { PhoneCryptoConfig } from "@tavo/security";
import { lookupCandidates, normalizePhone, sealPhone } from "@tavo/security";
import type { TrustedTenantContext } from "@tavo/shared";
import { Errors, isExclusionViolation } from "@tavo/shared";
import {
  cancelAppointment,
  consumeOfferedSlot,
  findCustomerByLookup,
  getAppointment,
  getBookingCommand,
  getStaff,
  insertAppointment,
  insertAudit,
  insertBookingCommand,
  lockOfferedSlot,
  upsertCustomer,
  updateAppointmentSchedule,
  withTenant,
} from "@tavo/database";
import { SchedulingService } from "./scheduling-service";

const OWNER_BOOKING_SOURCES = new Set(["HARNESS", "INTERNAL", "SEED", "MANUAL", "PHONE", "WALK_IN"]);

export class AppointmentService {
  constructor(
    private readonly pool: Pool,
    private readonly scheduling: SchedulingService,
    private readonly phones: PhoneCryptoConfig,
  ) {}

  async create(
    ctx: TrustedTenantContext,
    input: {
      staffId: string;
      serviceId: string;
      startAt: Date;
      customerPhone: string;
      customerName?: string;
      source?: string;
    },
  ) {
    const source = input.source ?? "INTERNAL";
    if (!OWNER_BOOKING_SOURCES.has(source)) {
      throw Errors.validation("appointment source");
    }
    let normalized: string;
    try {
      normalized = normalizePhone(input.customerPhone);
    } catch {
      throw Errors.validation("phone");
    }
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const { occupancy, service } = await this.scheduling.assertSlotAvailableOnClient(
        client,
        ctx,
        { serviceId: input.serviceId, staffId: input.staffId, startAt: input.startAt },
      );
      const staff = await getStaff(client, ctx.tenantId, input.staffId);
      if (!staff) throw Errors.notFound("staff");
      const candidates = lookupCandidates(normalized, this.phones.hmacKeyring);
      let customer = await findCustomerByLookup(client, ctx.tenantId, candidates);
      if (!customer) {
        const sealed = sealPhone(normalized, this.phones);
        customer = await upsertCustomer(client, ctx.tenantId, {
          name: input.customerName ?? null,
          phoneEncrypted: sealed.phoneEncrypted,
          phoneEncryptionKeyVersion: sealed.phoneEncryptionKeyVersion,
          phoneLookupHash: sealed.phoneLookupHash,
          phoneLookupKeyVersion: sealed.phoneLookupKeyVersion,
        });
      }
      try {
        const row = await insertAppointment(client, ctx.tenantId, {
          customerId: customer.id,
          staffId: input.staffId,
          serviceId: input.serviceId,
          locationId: staff.location_id,
          startAt: occupancy.startAt,
          endAt: occupancy.endAt,
          occupiedStartAt: occupancy.occupiedStartAt,
          occupiedEndAt: occupancy.occupiedEndAt,
          source,
        });
        await insertAudit(client, ctx.tenantId, {
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: "appointment.created",
          objectType: "appointment",
          objectId: row.id,
          metadata: { serviceId: service.id, source, staffId: input.staffId },
        });
        return row;
      } catch (e) {
        if (isExclusionViolation(e)) throw Errors.slotNoLongerAvailable();
        throw e;
      }
    });
  }

  async blockTime(
    ctx: TrustedTenantContext,
    input: { staffId: string; startAt: Date; endAt: Date; internalNote?: string },
  ) {
    if (!(input.startAt < input.endAt)) throw Errors.validation("blocked range");
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const staff = await getStaff(client, ctx.tenantId, input.staffId);
      if (!staff || !staff.active) throw Errors.notFound("staff");
      try {
        const row = await insertAppointment(client, ctx.tenantId, {
          customerId: null,
          staffId: input.staffId,
          serviceId: null,
          locationId: null,
          startAt: input.startAt,
          endAt: input.endAt,
          occupiedStartAt: input.startAt,
          occupiedEndAt: input.endAt,
          source: "BLOCKED",
          internalNote: input.internalNote ?? null,
        });
        await insertAudit(client, ctx.tenantId, {
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: "occupancy.blocked",
          objectType: "appointment",
          objectId: row.id,
          metadata: { staffId: input.staffId },
        });
        return row;
      } catch (e) {
        if (isExclusionViolation(e)) throw Errors.slotNoLongerAvailable();
        throw e;
      }
    });
  }

  async reschedule(ctx: TrustedTenantContext, appointmentId: string, startAt: Date) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      return this.rescheduleOnClient(client, ctx, appointmentId, startAt);
    });
  }

  async rescheduleOnClient(
    client: PoolClient,
    ctx: TrustedTenantContext,
    appointmentId: string,
    startAt: Date,
    opts?: { customerId: string; commandKey: string; inboundEventId: string },
  ) {
    if (opts) {
      const existingCmd = await getBookingCommand(client, ctx.tenantId, opts.commandKey);
      if (existingCmd) {
        const row = await getAppointment(client, ctx.tenantId, existingCmd.appointment_id);
        if (row) return row;
      }
    }
    const existing = await getAppointment(client, ctx.tenantId, appointmentId);
    if (!existing || existing.status !== "CONFIRMED" || !existing.service_id) {
      throw Errors.notFound("appointment");
    }
    if (opts && existing.customer_id !== opts.customerId) {
      throw Errors.notFound("appointment");
    }
    const { occupancy } = await this.scheduling.assertSlotAvailableOnClient(client, ctx, {
      serviceId: existing.service_id,
      staffId: existing.staff_id,
      startAt,
      exceptAppointmentId: existing.id,
    });
    const row = await updateAppointmentSchedule(client, ctx.tenantId, existing.id, {
      startAt: occupancy.startAt,
      endAt: occupancy.endAt,
      occupiedStartAt: occupancy.occupiedStartAt,
      occupiedEndAt: occupancy.occupiedEndAt,
    });
    if (!row) throw Errors.notFound("appointment");
    if (opts) {
      await insertBookingCommand(client, ctx.tenantId, {
        commandKey: opts.commandKey,
        operation: "RESCHEDULE",
        inboundEventId: opts.inboundEventId,
        appointmentId: row.id,
        resultJson: { id: row.id, startAt: row.start_at.toISOString(), status: row.status },
      });
    }
    await insertAudit(client, ctx.tenantId, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "appointment.rescheduled",
      objectType: "appointment",
      objectId: row.id,
    });
    return row;
  }

  async cancel(ctx: TrustedTenantContext, appointmentId: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      return this.cancelOnClient(client, ctx, appointmentId);
    });
  }

  async cancelOnClient(
    client: PoolClient,
    ctx: TrustedTenantContext,
    appointmentId: string,
    command?: { commandKey: string; inboundEventId: string; customerId: string; notBefore?: Date },
  ) {
    if (command) {
      const existing = await getBookingCommand(client, ctx.tenantId, command.commandKey);
      if (existing) {
        const row = await getAppointment(client, ctx.tenantId, existing.appointment_id);
        if (row) return row;
      }
    }
    const existing = await getAppointment(client, ctx.tenantId, appointmentId);
    if (!existing || existing.status !== "CONFIRMED") {
      throw Errors.notFound("appointment");
    }
    if (command && existing.customer_id !== command.customerId) {
      throw Errors.notFound("appointment");
    }
    if (command?.notBefore && existing.start_at.getTime() <= command.notBefore.getTime()) {
      throw Errors.notFound("appointment");
    }
    const row = await cancelAppointment(client, ctx.tenantId, appointmentId);
    if (!row) throw Errors.notFound("appointment");
    if (command) {
      await insertBookingCommand(client, ctx.tenantId, {
        commandKey: command.commandKey,
        operation: "CANCEL",
        inboundEventId: command.inboundEventId,
        appointmentId: row.id,
        resultJson: { id: row.id, status: row.status },
      });
    }
    await insertAudit(client, ctx.tenantId, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "appointment.cancelled",
      objectType: "appointment",
      objectId: row.id,
    });
    return row;
  }

  async bookFromOfferedSlot(
    client: PoolClient,
    ctx: TrustedTenantContext,
    input: {
      conversationId: string;
      slotRef: string;
      customerId: string;
      inboundEventId: string;
      commandKey: string;
    },
  ) {
    const replay = await getBookingCommand(client, ctx.tenantId, input.commandKey);
    if (replay) {
      const row = await getAppointment(client, ctx.tenantId, replay.appointment_id);
      if (row) return row;
    }
    const slot = await lockOfferedSlot(client, ctx.tenantId, input.conversationId, input.slotRef);
    if (!slot) throw Errors.validation("unknown slot");
    if (slot.consumed_at) throw Errors.validation("slot already used");
    if (slot.expires_at.getTime() <= Date.now()) throw Errors.validation("slot expired");
    const { occupancy, service } = await this.scheduling.assertSlotAvailableOnClient(client, ctx, {
      serviceId: slot.service_id,
      staffId: slot.staff_id,
      startAt: slot.start_at,
    });
    const staff = await getStaff(client, ctx.tenantId, slot.staff_id);
    if (!staff) throw Errors.notFound("staff");
    const row = await insertAppointment(client, ctx.tenantId, {
      customerId: input.customerId,
      staffId: slot.staff_id,
      serviceId: slot.service_id,
      locationId: staff.location_id,
      startAt: occupancy.startAt,
      endAt: occupancy.endAt,
      occupiedStartAt: occupancy.occupiedStartAt,
      occupiedEndAt: occupancy.occupiedEndAt,
      source: "WHATSAPP",
    });
    const consumed = await consumeOfferedSlot(client, ctx.tenantId, input.slotRef, input.inboundEventId);
    if (!consumed) throw Errors.validation("slot already used");
    await insertBookingCommand(client, ctx.tenantId, {
      commandKey: input.commandKey,
      operation: "CREATE",
      inboundEventId: input.inboundEventId,
      appointmentId: row.id,
      resultJson: { id: row.id, startAt: row.start_at.toISOString(), status: row.status },
    });
    await insertAudit(client, ctx.tenantId, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "appointment.created",
      objectType: "appointment",
      objectId: row.id,
      metadata: { serviceId: service.id, source: "WHATSAPP" },
    });
    return row;
  }

  async rescheduleFromOfferedSlot(
    client: PoolClient,
    ctx: TrustedTenantContext,
    input: {
      conversationId: string;
      slotRef: string;
      customerId: string;
      inboundEventId: string;
      commandKey: string;
      appointmentId: string;
    },
  ) {
    const replay = await getBookingCommand(client, ctx.tenantId, input.commandKey);
    if (replay) {
      const row = await getAppointment(client, ctx.tenantId, replay.appointment_id);
      if (row) return row;
    }
    const existing = await getAppointment(client, ctx.tenantId, input.appointmentId);
    if (
      !existing ||
      existing.status !== "CONFIRMED" ||
      !existing.service_id ||
      existing.customer_id !== input.customerId
    ) {
      throw Errors.notFound("appointment");
    }
    const slot = await lockOfferedSlot(client, ctx.tenantId, input.conversationId, input.slotRef);
    if (!slot) throw Errors.validation("unknown slot");
    if (slot.consumed_at) throw Errors.validation("slot already used");
    if (slot.expires_at.getTime() <= Date.now()) throw Errors.validation("slot expired");
    const { occupancy } = await this.scheduling.assertSlotAvailableOnClient(client, ctx, {
      serviceId: existing.service_id,
      staffId: slot.staff_id,
      startAt: slot.start_at,
      exceptAppointmentId: existing.id,
    });
    const row = await updateAppointmentSchedule(client, ctx.tenantId, existing.id, {
      startAt: occupancy.startAt,
      endAt: occupancy.endAt,
      occupiedStartAt: occupancy.occupiedStartAt,
      occupiedEndAt: occupancy.occupiedEndAt,
    });
    if (!row) throw Errors.notFound("appointment");
    const consumed = await consumeOfferedSlot(client, ctx.tenantId, input.slotRef, input.inboundEventId);
    if (!consumed) throw Errors.validation("slot already used");
    await insertBookingCommand(client, ctx.tenantId, {
      commandKey: input.commandKey,
      operation: "RESCHEDULE",
      inboundEventId: input.inboundEventId,
      appointmentId: row.id,
      resultJson: { id: row.id, startAt: row.start_at.toISOString(), status: row.status },
    });
    await insertAudit(client, ctx.tenantId, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "appointment.rescheduled",
      objectType: "appointment",
      objectId: row.id,
      metadata: { source: "WHATSAPP" },
    });
    return row;
  }

  async get(ctx: TrustedTenantContext, appointmentId: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await getAppointment(client, ctx.tenantId, appointmentId);
      if (!row) throw Errors.notFound("appointment");
      return row;
    });
  }
}
