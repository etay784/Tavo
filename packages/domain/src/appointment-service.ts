import type { Pool } from "pg";
import type { PhoneCryptoConfig } from "@tavo/security";
import { lookupCandidates, normalizePhone, sealPhone } from "@tavo/security";
import type { TrustedTenantContext } from "@tavo/shared";
import { Errors } from "@tavo/shared";
import {
  cancelAppointment,
  findCustomerByLookup,
  getAppointment,
  getStaff,
  insertAppointment,
  insertAudit,
  upsertCustomer,
  updateAppointmentSchedule,
  withTenant,
} from "@tavo/database";
import { SchedulingService } from "./scheduling-service";

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
    const normalized = normalizePhone(input.customerPhone);
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
      const row = await insertAppointment(client, ctx.tenantId, {
        customerId: customer.id,
        staffId: input.staffId,
        serviceId: input.serviceId,
        locationId: staff.location_id,
        startAt: occupancy.startAt,
        endAt: occupancy.endAt,
        occupiedStartAt: occupancy.occupiedStartAt,
        occupiedEndAt: occupancy.occupiedEndAt,
        source: input.source ?? "INTERNAL",
      });
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "appointment.created",
        objectType: "appointment",
        objectId: row.id,
        metadata: { serviceId: service.id },
      });
      return row;
    });
  }

  async reschedule(ctx: TrustedTenantContext, appointmentId: string, startAt: Date) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const existing = await getAppointment(client, ctx.tenantId, appointmentId);
      if (!existing || existing.status !== "CONFIRMED") {
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
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "appointment.rescheduled",
        objectType: "appointment",
        objectId: row.id,
      });
      return row;
    });
  }

  async cancel(ctx: TrustedTenantContext, appointmentId: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await cancelAppointment(client, ctx.tenantId, appointmentId);
      if (!row) throw Errors.notFound("appointment");
      await insertAudit(client, ctx.tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "appointment.cancelled",
        objectType: "appointment",
        objectId: row.id,
      });
      return row;
    });
  }

  async get(ctx: TrustedTenantContext, appointmentId: string) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const row = await getAppointment(client, ctx.tenantId, appointmentId);
      if (!row) throw Errors.notFound("appointment");
      return row;
    });
  }
}
