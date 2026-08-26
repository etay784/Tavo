import { randomBytes, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import type { Keyring } from "@tavo/security";
import {
  decryptUtf8,
  encryptUtf8,
  lookupCandidates,
  normalizePhone,
  sealPhone,
  type PhoneCryptoConfig,
} from "@tavo/security";
import type { Clock, TrustedTenantContext } from "@tavo/shared";
import {
  Errors,
  INBOUND_MAX_ATTEMPTS,
  LEASE_TTL_SECONDS,
  ORCHESTRATOR_DEADLINE_MS,
  retryBackoffSeconds,
} from "@tavo/shared";
import {
  attachInboundConversation,
  getBusiness,
  getInboundEvent,
  getStaff,
  insertAudit,
  insertChatMessage,
  insertOfferedSlots,
  insertOutboundMessage,
  listCustomerAppointments,
  listOpenOfferedSlots,
  listServices,
  markInboundFailed,
  markInboundProcessed,
  releaseConversationLease,
  tryAcquireConversationLease,
  updateConversationState,
  upsertConversation,
  findCustomerByLookup,
  upsertCustomer,
  withTenant,
} from "@tavo/database";
import { AppointmentService, SchedulingService } from "@tavo/domain";
import { FakeAIProvider, IntentSchema, type AIProvider, type StructuredIntent } from "@tavo/ai";
import { consumeLlmBudget, LLM_BUDGET_HE } from "./llm-budget";
import {
  CANCELLED_HE,
  FALLBACK_HE,
  formatAvailabilityList,
  formatBookingConfirmation,
  formatBookingsList,
  formatBusinessInfo,
  formatPrices,
  formatRescheduleConfirmation,
  formatServiceChoices,
  NO_BOOKING_HE,
} from "./formatters";

export type MessageCrypto = {
  encryptionKeyring: Keyring;
  writeVersion: number;
};

type Offered = {
  slotRef: string;
  staffId: string;
  serviceId: string;
  startAt: Date;
  ordinal: number;
  expiresAt: Date;
  staffName: string;
};

type Plan = {
  facts: string;
  state: string;
  serviceId?: string | null;
  pendingAppointmentId?: string | null;
  offerSetId?: string;
  offered?: Offered[];
  book?: { slotRef: string };
  cancelId?: string;
  rescheduleFromSlot?: { slotRef: string; appointmentId: string };
  intent?: string;
};

function newSlotRef(): string {
  return `slot_${randomBytes(16).toString("base64url")}`;
}

function matchService(
  services: { id: string; name: string }[],
  hint?: string,
): { id: string; name: string } | undefined {
  if (!hint) return undefined;
  const n = hint.trim().toLowerCase();
  return services.find((s) => s.name.toLowerCase() === n || s.name.toLowerCase().includes(n));
}

export class InboundProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly phones: PhoneCryptoConfig,
    private readonly messages: MessageCrypto,
    private readonly scheduling: SchedulingService,
    private readonly appointments: AppointmentService,
    private readonly ai: AIProvider = new FakeAIProvider(),
    private readonly deadlineMs: number = ORCHESTRATOR_DEADLINE_MS,
  ) {}

  async processClaimedJob(jobId: string, tenantId: string, _workerId: string): Promise<void> {
    const ctx: TrustedTenantContext = {
      tenantId,
      actorType: "WHATSAPP",
      actorId: "inbound-worker",
    };
    const leaseToken = randomUUID();
    const prepared = await withTenant(this.pool, tenantId, async (client) => {
      const event = await getInboundEvent(client, tenantId, jobId);
      if (!event || event.event_kind !== "message_text" || !event.sender_encrypted) {
        throw new Error("inbound event missing");
      }
      const sender = decryptUtf8(
        event.sender_encrypted,
        this.messages.encryptionKeyring,
        event.sender_encryption_key_version ?? this.messages.writeVersion,
      );
      const normalized = normalizePhone(sender);
      const candidates = lookupCandidates(normalized, this.phones.hmacKeyring);
      let customer = await findCustomerByLookup(client, tenantId, candidates);
      if (!customer) {
        const sealed = sealPhone(normalized, this.phones);
        customer = await upsertCustomer(client, tenantId, {
          name: null,
          phoneEncrypted: sealed.phoneEncrypted,
          phoneEncryptionKeyVersion: sealed.phoneEncryptionKeyVersion,
          phoneLookupHash: sealed.phoneLookupHash,
          phoneLookupKeyVersion: sealed.phoneLookupKeyVersion,
        });
      }
      const conversation = await upsertConversation(client, tenantId, customer.id);
      await attachInboundConversation(client, tenantId, jobId, conversation.id);
      const lease = await tryAcquireConversationLease(
        client,
        tenantId,
        conversation.id,
        leaseToken,
        LEASE_TTL_SECONDS,
      );
      if (!lease) {
        await markInboundFailed(
          client,
          tenantId,
          jobId,
          "conversation leased",
          5,
          INBOUND_MAX_ATTEMPTS,
        );
        return null;
      }
      const text = event.text_encrypted
        ? decryptUtf8(
            event.text_encrypted,
            this.messages.encryptionKeyring,
            event.text_encryption_key_version ?? this.messages.writeVersion,
          )
        : "";
      return {
        customerId: customer.id,
        conversationId: conversation.id,
        lockVersion: lease.lock_version,
        leaseToken,
        text,
        integrationId: event.integration_id,
        inboundId: jobId,
        attemptCount: event.attempt_count,
        state: conversation.state,
        serviceId: conversation.service_id,
        pendingAppointmentId: conversation.pending_appointment_id,
        clarifyCount: conversation.clarify_count,
      };
    });
    if (!prepared) return;

    const ac = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => ac.abort(), this.deadlineMs);
    let plan: Plan;
    try {
      plan = await this.plan(ctx, prepared, ac.signal);
      if (ac.signal.aborted || Date.now() - started >= this.deadlineMs) {
        throw new Error("orchestrator deadline");
      }
    } catch (e) {
      await withTenant(this.pool, tenantId, (client) =>
        markInboundFailed(
          client,
          tenantId,
          jobId,
          e instanceof Error ? e.message : "plan",
          retryBackoffSeconds(prepared.attemptCount),
          INBOUND_MAX_ATTEMPTS,
        ),
      );
      await withTenant(this.pool, tenantId, (client) =>
        releaseConversationLease(
          client,
          tenantId,
          prepared.conversationId,
          prepared.leaseToken,
          prepared.lockVersion,
        ),
      );
      return;
    } finally {
      clearTimeout(timer);
    }

    await withTenant(this.pool, tenantId, async (client) => {
      const still = await updateConversationState(
        client,
        tenantId,
        prepared.conversationId,
        prepared.leaseToken,
        prepared.lockVersion,
        {
          state: plan.state,
          serviceId: plan.serviceId ?? null,
          pendingAppointmentId: plan.pendingAppointmentId ?? null,
          currentOfferSetId: plan.offerSetId ?? null,
        },
      );
      if (!still) {
        await markInboundFailed(
          client,
          tenantId,
          jobId,
          "lost lease",
          5,
          INBOUND_MAX_ATTEMPTS,
        );
        return;
      }
      if (plan.offered && plan.offerSetId) {
        await insertOfferedSlots(
          client,
          tenantId,
          prepared.conversationId,
          plan.offerSetId,
          plan.offered,
        );
      }
      if (plan.book) {
        await this.appointments.bookFromOfferedSlot(client, ctx, {
          conversationId: prepared.conversationId,
          slotRef: plan.book.slotRef,
          customerId: prepared.customerId,
          inboundEventId: prepared.inboundId,
          commandKey: `create:${prepared.inboundId}`,
        });
      }
      if (plan.cancelId) {
        await this.appointments.cancelOnClient(client, ctx, plan.cancelId, {
          commandKey: `cancel:${prepared.inboundId}`,
          inboundEventId: prepared.inboundId,
          customerId: prepared.customerId,
        });
      }
      if (plan.rescheduleFromSlot) {
        await this.appointments.rescheduleFromOfferedSlot(client, ctx, {
          conversationId: prepared.conversationId,
          slotRef: plan.rescheduleFromSlot.slotRef,
          customerId: prepared.customerId,
          inboundEventId: prepared.inboundId,
          commandKey: `reschedule:${prepared.inboundId}`,
          appointmentId: plan.rescheduleFromSlot.appointmentId,
        });
      }
      const enc = encryptUtf8(plan.facts, this.messageKey(), this.messages.writeVersion);
      const inboundEnc = encryptUtf8(prepared.text, this.messageKey(), this.messages.writeVersion);
      await insertChatMessage(client, tenantId, {
        conversationId: prepared.conversationId,
        direction: "INBOUND",
        bodyEncrypted: inboundEnc.ciphertext,
        messageEncryptionKeyVersion: inboundEnc.version,
        inboundEventId: prepared.inboundId,
      });
      const out = await insertOutboundMessage(client, tenantId, {
        customerId: prepared.customerId,
        integrationId: prepared.integrationId,
        conversationId: prepared.conversationId,
        causedByInboundEventId: prepared.inboundId,
        bodyEncrypted: enc.ciphertext,
        messageEncryptionKeyVersion: enc.version,
      });
      await insertChatMessage(client, tenantId, {
        conversationId: prepared.conversationId,
        direction: "OUTBOUND",
        bodyEncrypted: enc.ciphertext,
        messageEncryptionKeyVersion: enc.version,
        outboundId: out.id,
      });
      await insertAudit(client, tenantId, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: "conversation.turn",
        objectType: "conversation",
        objectId: prepared.conversationId,
        metadata: { intent: plan.intent ?? "UNKNOWN", inboundEventId: prepared.inboundId },
      });
      await markInboundProcessed(client, tenantId, jobId);
      await releaseConversationLease(
        client,
        tenantId,
        prepared.conversationId,
        prepared.leaseToken,
        prepared.lockVersion,
      );
    });
  }

  private messageKey(): Buffer {
    const k = this.messages.encryptionKeyring.get(this.messages.writeVersion);
    if (!k) throw new Error("message write key missing");
    return k;
  }

  private async plan(
    ctx: TrustedTenantContext,
    prepared: {
      customerId: string;
      conversationId: string;
      text: string;
      inboundId: string;
      state: string;
      serviceId: string | null;
      pendingAppointmentId: string | null;
    },
    signal: AbortSignal,
  ): Promise<Plan> {
    if (!consumeLlmBudget(ctx.tenantId, prepared.customerId)) {
      await withTenant(this.pool, ctx.tenantId, (client) =>
        insertAudit(client, ctx.tenantId, {
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: "conversation.llm_budget",
          objectType: "conversation",
          objectId: prepared.conversationId,
          metadata: { reason: "limit" },
        }),
      );
      return { facts: LLM_BUDGET_HE, state: prepared.state, intent: "UNKNOWN" };
    }

    let parsed: StructuredIntent;
    try {
      parsed = IntentSchema.parse(await this.ai.extractIntent({ userText: prepared.text, signal }));
    } catch {
      if (signal.aborted) throw new Error("orchestrator deadline");
      return { facts: FALLBACK_HE, state: "IDLE", intent: "UNKNOWN" };
    }
    if (parsed.intent === "UNKNOWN" || parsed.confidence < 0.5) {
      return { facts: FALLBACK_HE, state: "IDLE", intent: parsed.intent };
    }

    const snapshot = await withTenant(this.pool, ctx.tenantId, async (client) => {
      const business = await getBusiness(client, ctx.tenantId);
      const services = await listServices(client, ctx.tenantId);
      const open = await listOpenOfferedSlots(client, ctx.tenantId, prepared.conversationId);
      const appts = await listCustomerAppointments(client, ctx.tenantId, prepared.customerId);
      return { business, services, open, appts };
    });
    if (!snapshot.business) throw Errors.notFound("business");
    const business = snapshot.business;

    if (parsed.intent === "GET_PRICE") {
      return {
        facts: formatPrices(snapshot.services.map((s) => ({ name: s.name, priceMinor: s.price_minor }))),
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        intent: parsed.intent,
      };
    }
    if (parsed.intent === "GET_BUSINESS_INFO") {
      return {
        facts: formatBusinessInfo({ name: business.name, timeZone: business.timezone }),
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        intent: parsed.intent,
      };
    }
    if (parsed.intent === "GET_BOOKING") {
      const rows = [];
      for (const a of snapshot.appts) {
        const staff = await withTenant(this.pool, ctx.tenantId, (c) =>
          getStaff(c, ctx.tenantId, a.staff_id),
        );
        const svc = snapshot.services.find((s) => s.id === a.service_id);
        rows.push({
          startAt: a.start_at,
          serviceName: svc?.name ?? "",
          staffName: staff?.name ?? "",
        });
      }
      return {
        facts: formatBookingsList(rows, business.timezone),
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        intent: parsed.intent,
      };
    }
    if (parsed.intent === "CANCEL_BOOKING" || prepared.state === "AWAITING_CANCEL_CONFIRM") {
      return this.planCancel(ctx, prepared, parsed, snapshot, business.timezone);
    }
    if (parsed.intent === "RESCHEDULE_BOOKING" || prepared.state === "AWAITING_RESCHEDULE_SLOT") {
      return this.planReschedule(ctx, prepared, parsed, snapshot, business);
    }
    if (parsed.intent === "FIND_AVAILABILITY" || parsed.intent === "CLARIFY") {
      return this.planAvailability(ctx, prepared, parsed, snapshot, business);
    }
    if (parsed.intent === "SELECT_SLOT" || parsed.intent === "CREATE_BOOKING") {
      if (prepared.state === "AWAITING_CANCEL_CONFIRM") {
        return this.planCancel(ctx, prepared, parsed, snapshot, business.timezone);
      }
      if (prepared.state === "AWAITING_RESCHEDULE_SLOT") {
        return this.planRescheduleSelect(ctx, prepared, parsed, snapshot, business);
      }
      return this.planSelectConfirm(ctx, prepared, parsed, snapshot, business);
    }
    return { facts: FALLBACK_HE, state: "IDLE", intent: parsed.intent };
  }

  private async planAvailability(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string; serviceId: string | null },
    parsed: StructuredIntent,
    snapshot: {
      services: { id: string; name: string; price_minor: number }[];
    },
    business: { timezone: string },
  ): Promise<Plan> {
    const hinted = matchService(snapshot.services, parsed.service_name);
    const service =
      hinted ??
      snapshot.services.find((s) => s.id === prepared.serviceId) ??
      (snapshot.services.length === 1 ? snapshot.services[0] : undefined);
    if (!service) {
      return {
        facts: formatServiceChoices(snapshot.services),
        state: "AWAITING_SERVICE",
        serviceId: null,
        intent: "FIND_AVAILABILITY",
      };
    }
    const { from, to } = civilWindow(
      this.clock.now(),
      business.timezone,
      parsed.relative_when ?? "TOMORROW",
      parsed.time_window ?? "EVENING",
    );
    const slots = await this.scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      from,
      to,
    });
    const capped = slots.slice(0, 5);
    const offerSetId = randomUUID();
    const expiresAt = new Date(Math.max(Date.now(), this.clock.now().getTime()) + 2 * 60 * 60 * 1000);
    const offered: Offered[] = capped.map((s, i) => ({
      slotRef: newSlotRef(),
      staffId: s.staffId,
      serviceId: service.id,
      startAt: s.startAt,
      ordinal: i + 1,
      expiresAt,
      staffName: s.staffName,
    }));
    const facts = formatAvailabilityList(
      offered.map((o) => ({ ordinal: o.ordinal, startAt: o.startAt, staffName: o.staffName })),
      business.timezone,
    );
    return {
      facts,
      state: "OFFERING_SLOTS",
      serviceId: service.id,
      offerSetId,
      offered,
      intent: "FIND_AVAILABILITY",
    };
  }

  private async planSelectConfirm(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string; serviceId: string | null },
    parsed: StructuredIntent,
    snapshot: {
      open: { slot_ref: string; ordinal: number; staff_id: string; service_id: string; start_at: Date }[];
      services: { id: string; name: string }[];
    },
    business: { timezone: string },
  ): Promise<Plan> {
    const match =
      (parsed.slot_ref ? snapshot.open.find((s) => s.slot_ref === parsed.slot_ref) : undefined) ??
      (parsed.ordinal ? snapshot.open.find((s) => s.ordinal === parsed.ordinal) : undefined);
    if (!match) {
      return {
        facts: FALLBACK_HE,
        state: "OFFERING_SLOTS",
        serviceId: prepared.serviceId,
        intent: parsed.intent,
      };
    }
    const staff = await withTenant(this.pool, ctx.tenantId, (c) =>
      getStaff(c, ctx.tenantId, match.staff_id),
    );
    const service = snapshot.services.find((s) => s.id === match.service_id);
    return {
      facts: formatBookingConfirmation({
        startAt: match.start_at,
        staffName: staff?.name ?? "",
        serviceName: service?.name ?? "",
        timeZone: business.timezone,
      }),
      book: { slotRef: match.slot_ref },
      state: "IDLE",
      serviceId: match.service_id,
      intent: parsed.intent,
    };
  }

  private async planCancel(
    ctx: TrustedTenantContext,
    prepared: { pendingAppointmentId: string | null; serviceId: string | null; state: string },
    parsed: StructuredIntent,
    snapshot: {
      appts: { id: string; staff_id: string; service_id: string; start_at: Date; customer_id: string }[];
      services: { id: string; name: string }[];
    },
    timeZone: string,
  ): Promise<Plan> {
    let targetId: string | undefined;
    if (parsed.appointment_id) {
      const owned = snapshot.appts.find((a) => a.id === parsed.appointment_id);
      targetId = owned?.id;
    }
    if (!targetId && parsed.ordinal && prepared.state === "AWAITING_CANCEL_CONFIRM") {
      targetId = snapshot.appts[parsed.ordinal - 1]?.id;
    }
    if (!targetId && snapshot.appts.length === 1) {
      targetId = snapshot.appts[0]?.id;
    }
    if (!targetId) {
      if (snapshot.appts.length === 0) {
        return { facts: NO_BOOKING_HE, state: "IDLE", intent: "CANCEL_BOOKING" };
      }
      const rows = [];
      for (const a of snapshot.appts) {
        const staff = await withTenant(this.pool, ctx.tenantId, (c) =>
          getStaff(c, ctx.tenantId, a.staff_id),
        );
        rows.push({
          startAt: a.start_at,
          serviceName: snapshot.services.find((s) => s.id === a.service_id)?.name ?? "",
          staffName: staff?.name ?? "",
        });
      }
      return {
        facts: formatBookingsList(rows, timeZone),
        state: "AWAITING_CANCEL_CONFIRM",
        serviceId: prepared.serviceId,
        intent: "CANCEL_BOOKING",
      };
    }
    return {
      facts: CANCELLED_HE,
      state: "IDLE",
      cancelId: targetId,
      serviceId: prepared.serviceId,
      intent: "CANCEL_BOOKING",
    };
  }

  private async planReschedule(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string; serviceId: string | null; pendingAppointmentId: string | null },
    parsed: StructuredIntent,
    snapshot: {
      appts: { id: string; staff_id: string; service_id: string; start_at: Date }[];
      services: { id: string; name: string; price_minor: number }[];
      open: { slot_ref: string; ordinal: number; staff_id: string; service_id: string; start_at: Date }[];
    },
    business: { timezone: string },
  ): Promise<Plan> {
    if (prepared.pendingAppointmentId && (parsed.intent === "SELECT_SLOT" || parsed.intent === "CREATE_BOOKING")) {
      return this.planRescheduleSelect(ctx, prepared, parsed, snapshot, business);
    }
    let appt = snapshot.appts.find((a) => a.id === parsed.appointment_id);
    if (!appt && snapshot.appts.length === 1) appt = snapshot.appts[0];
    if (!appt) {
      if (snapshot.appts.length === 0) {
        return { facts: NO_BOOKING_HE, state: "IDLE", intent: "RESCHEDULE_BOOKING" };
      }
      return {
        facts: formatBookingsList(
          snapshot.appts.map((a) => ({
            startAt: a.start_at,
            serviceName: snapshot.services.find((s) => s.id === a.service_id)?.name ?? "",
            staffName: "",
          })),
          business.timezone,
        ),
        state: "AWAITING_RESCHEDULE_SLOT",
        pendingAppointmentId: snapshot.appts[0]?.id ?? null,
        serviceId: snapshot.appts[0]?.service_id ?? null,
        intent: "RESCHEDULE_BOOKING",
      };
    }
    return this.planAvailability(
      ctx,
      { conversationId: prepared.conversationId, serviceId: appt.service_id },
      { ...parsed, intent: "FIND_AVAILABILITY", confidence: 1, relative_when: parsed.relative_when ?? "TOMORROW" },
      snapshot,
      business,
    ).then((p) => ({
      ...p,
      state: "AWAITING_RESCHEDULE_SLOT",
      pendingAppointmentId: appt.id,
      intent: "RESCHEDULE_BOOKING",
    }));
  }

  private async planRescheduleSelect(
    ctx: TrustedTenantContext,
    prepared: { pendingAppointmentId: string | null; serviceId: string | null },
    parsed: StructuredIntent,
    snapshot: {
      open: { slot_ref: string; ordinal: number; staff_id: string; service_id: string; start_at: Date }[];
      services: { id: string; name: string }[];
    },
    business: { timezone: string },
  ): Promise<Plan> {
    const match =
      (parsed.slot_ref ? snapshot.open.find((s) => s.slot_ref === parsed.slot_ref) : undefined) ??
      (parsed.ordinal ? snapshot.open.find((s) => s.ordinal === parsed.ordinal) : undefined);
    const appointmentId = prepared.pendingAppointmentId;
    if (!match || !appointmentId) {
      return {
        facts: FALLBACK_HE,
        state: "AWAITING_RESCHEDULE_SLOT",
        pendingAppointmentId: appointmentId,
        serviceId: prepared.serviceId,
        intent: parsed.intent,
      };
    }
    const staff = await withTenant(this.pool, ctx.tenantId, (c) =>
      getStaff(c, ctx.tenantId, match.staff_id),
    );
    const service = snapshot.services.find((s) => s.id === match.service_id);
    return {
      facts: formatRescheduleConfirmation({
        startAt: match.start_at,
        staffName: staff?.name ?? "",
        serviceName: service?.name ?? "",
        timeZone: business.timezone,
      }),
      state: "IDLE",
      rescheduleFromSlot: { slotRef: match.slot_ref, appointmentId },
      serviceId: match.service_id,
      pendingAppointmentId: null,
      intent: parsed.intent,
    };
  }
}

export function civilWindow(
  now: Date,
  timeZone: string,
  relative: "TODAY" | "TOMORROW" | "THIS_WEEK",
  window: "MORNING" | "AFTERNOON" | "EVENING",
): { from: Date; to: Date } {
  let day = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timeZone).startOf("day");
  if (relative === "TOMORROW") day = day.plus({ days: 1 });
  const hours =
    window === "MORNING" ? ([9, 12] as const) : window === "AFTERNOON" ? ([12, 17] as const) : ([17, 21] as const);
  const from = day.set({ hour: hours[0], minute: 0, second: 0, millisecond: 0 });
  const to = day.set({ hour: hours[1], minute: 0, second: 0, millisecond: 0 });
  return { from: from.toUTC().toJSDate(), to: to.toUTC().toJSDate() };
}
