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
  findCustomerByLookup,
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
  listStaffNames,
  lockConversationLease,
  markInboundDeferred,
  markInboundFailed,
  markInboundProcessed,
  releaseConversationLease,
  tryAcquireConversationLease,
  updateConversationState,
  upsertConversation,
  upsertCustomer,
  withTenant,
} from "@tavo/database";
import { AppointmentService, SchedulingService } from "@tavo/domain";
import {
  FakeAIProvider,
  IntentSchema,
  MinContextSchema,
  type AIProvider,
  type MinContext,
  type StructuredIntent,
} from "@tavo/ai";
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

const SLOT_SELECT_STATES = new Set(["OFFERING_SLOTS", "AWAITING_BOOK_CONFIRM", "AWAITING_RESCHEDULE_SLOT"]);

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
  serviceId: string | null;
  pendingAppointmentId: string | null;
  offerSetId: string | null;
  offered?: Offered[];
  book?: { slotRef: string };
  cancelId?: string;
  rescheduleFromSlot?: { slotRef: string; appointmentId: string };
  intent?: string;
};

type Snapshot = {
  business: { name: string; timezone: string };
  services: { id: string; name: string; price_minor: number }[];
  staff: { id: string; name: string }[];
  open: { slot_ref: string; ordinal: number; staff_id: string; service_id: string; start_at: Date }[];
  appts: { id: string; staff_id: string; service_id: string; start_at: Date; customer_id: string }[];
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

function idlePlan(facts: string, intent: string): Plan {
  return {
    facts,
    state: "IDLE",
    serviceId: null,
    pendingAppointmentId: null,
    offerSetId: null,
    intent,
  };
}

export class InboundProcessor {
  failNextApply = false;

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
    try {
      await this.processClaimedJobInner(jobId, tenantId);
    } catch (e) {
      await withTenant(this.pool, tenantId, (client) =>
        markInboundFailed(
          client,
          tenantId,
          jobId,
          e instanceof Error ? e.message : "claimed-job",
          retryBackoffSeconds(8),
          INBOUND_MAX_ATTEMPTS,
        ),
      );
    }
  }

  private async processClaimedJobInner(jobId: string, tenantId: string): Promise<void> {
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
        await markInboundDeferred(client, tenantId, jobId, 3);
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
        currentOfferSetId: conversation.current_offer_set_id,
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

    try {
      await withTenant(this.pool, tenantId, async (client) => {
      if (this.failNextApply) {
        this.failNextApply = false;
        throw new Error("test apply failure");
      }
      const still = await lockConversationLease(
        client,
        tenantId,
        prepared.conversationId,
        prepared.leaseToken,
        prepared.lockVersion,
      );
      if (!still) {
        await markInboundFailed(client, tenantId, jobId, "lost lease", 5, INBOUND_MAX_ATTEMPTS);
        return;
      }
      if (plan.offered && plan.offerSetId) {
        await insertOfferedSlots(client, tenantId, prepared.conversationId, plan.offerSetId, plan.offered);
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
          notBefore: this.clock.now(),
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
      const wroteState = await updateConversationState(
        client,
        tenantId,
        prepared.conversationId,
        prepared.leaseToken,
        prepared.lockVersion,
        {
          state: plan.state,
          serviceId: plan.serviceId,
          pendingAppointmentId: plan.pendingAppointmentId,
          currentOfferSetId: plan.offerSetId,
        },
      );
      if (!wroteState) {
        await markInboundFailed(client, tenantId, jobId, "lost lease", 5, INBOUND_MAX_ATTEMPTS);
        return;
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
    } catch (e) {
      await withTenant(this.pool, tenantId, async (client) => {
        await markInboundFailed(
          client,
          tenantId,
          jobId,
          e instanceof Error ? e.message : "apply",
          retryBackoffSeconds(prepared.attemptCount),
          INBOUND_MAX_ATTEMPTS,
        );
        await releaseConversationLease(
          client,
          tenantId,
          prepared.conversationId,
          prepared.leaseToken,
          prepared.lockVersion,
        );
      });
    }
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
      currentOfferSetId: string | null;
    },
    signal: AbortSignal,
  ): Promise<Plan> {
    const snapshot = await withTenant(this.pool, ctx.tenantId, async (client) => {
      const allowed = await consumeLlmBudget(client, ctx.tenantId, prepared.customerId, this.clock.now());
      const business = await getBusiness(client, ctx.tenantId);
      const services = await listServices(client, ctx.tenantId);
      const staff = await listStaffNames(client, ctx.tenantId);
      const open = await listOpenOfferedSlots(client, ctx.tenantId, prepared.conversationId);
      const appts = await listCustomerAppointments(
        client,
        ctx.tenantId,
        prepared.customerId,
        this.clock.now(),
      );
      return { allowed, business, services, staff, open, appts };
    });
    if (!snapshot.business) throw Errors.notFound("business");
    if (!snapshot.allowed) {
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
      return {
        facts: LLM_BUDGET_HE,
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        offerSetId: prepared.currentOfferSetId,
        intent: "UNKNOWN",
      };
    }

    const nowCivil = DateTime.fromJSDate(this.clock.now(), { zone: "utc" })
      .setZone(snapshot.business.timezone)
      .toFormat("yyyy-LL-dd'T'HH:mm");
    const minContext: MinContext = MinContextSchema.parse({
      conversation_state: prepared.state,
      timezone: snapshot.business.timezone,
      now_civil: nowCivil,
      services: snapshot.services.map((s) => ({ name: s.name })),
      staff: snapshot.staff.map((s) => ({ name: s.name })),
      ...(snapshot.open.length
        ? {
            offered_options: snapshot.open.map((o) => ({
              ordinal: o.ordinal,
              label: DateTime.fromJSDate(o.start_at, { zone: "utc" })
                .setZone(snapshot.business!.timezone)
                .toFormat("HH:mm"),
            })),
          }
        : {}),
    });

    let parsed: StructuredIntent;
    try {
      parsed = IntentSchema.parse(
        await this.ai.extractIntent({ userText: prepared.text, context: minContext, signal }),
      );
    } catch {
      if (signal.aborted) throw new Error("orchestrator deadline");
      return idlePlan(FALLBACK_HE, "UNKNOWN");
    }
    if (parsed.intent === "UNKNOWN" || parsed.confidence < 0.5) {
      return idlePlan(FALLBACK_HE, parsed.intent);
    }

    const snap: Snapshot = {
      business: snapshot.business,
      services: snapshot.services,
      staff: snapshot.staff,
      open: snapshot.open,
      appts: snapshot.appts,
    };

    if (parsed.intent === "GET_PRICE") {
      return {
        facts: formatPrices(snap.services.map((s) => ({ name: s.name, priceMinor: s.price_minor }))),
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        offerSetId: prepared.currentOfferSetId,
        intent: parsed.intent,
      };
    }
    if (parsed.intent === "GET_BUSINESS_INFO") {
      return {
        facts: formatBusinessInfo({ name: snap.business.name, timeZone: snap.business.timezone }),
        state: prepared.state,
        serviceId: prepared.serviceId,
        pendingAppointmentId: prepared.pendingAppointmentId,
        offerSetId: prepared.currentOfferSetId,
        intent: parsed.intent,
      };
    }
    if (parsed.intent === "GET_BOOKING") {
      return this.planListBookings(ctx, prepared, snap, parsed.intent);
    }
    if (parsed.intent === "CANCEL_BOOKING" || prepared.state === "AWAITING_CANCEL_CONFIRM") {
      return this.planCancel(ctx, prepared, parsed, snap);
    }
    if (
      parsed.intent === "RESCHEDULE_BOOKING" ||
      prepared.state === "AWAITING_RESCHEDULE_SLOT" ||
      prepared.state === "AWAITING_RESCHEDULE_APPOINTMENT"
    ) {
      return this.planReschedule(ctx, prepared, parsed, snap);
    }
    if (parsed.intent === "SELECT_SERVICE" || prepared.state === "AWAITING_SERVICE") {
      return this.planServiceSelect(ctx, prepared, parsed, snap);
    }
    if (parsed.intent === "FIND_AVAILABILITY" || parsed.intent === "CLARIFY") {
      return this.planAvailability(ctx, prepared, parsed, snap);
    }
    if (parsed.intent === "SELECT_SLOT" || parsed.intent === "CREATE_BOOKING") {
      if (!SLOT_SELECT_STATES.has(prepared.state)) {
        return idlePlan(FALLBACK_HE, parsed.intent);
      }
      if (prepared.state === "AWAITING_RESCHEDULE_SLOT") {
        return this.planRescheduleSelect(ctx, prepared, parsed, snap);
      }
      return this.planSelectConfirm(ctx, prepared, parsed, snap);
    }
    return idlePlan(FALLBACK_HE, parsed.intent);
  }

  private async planListBookings(
    ctx: TrustedTenantContext,
    prepared: {
      serviceId: string | null;
      pendingAppointmentId: string | null;
      state: string;
      currentOfferSetId: string | null;
    },
    snap: Snapshot,
    intent: string,
  ): Promise<Plan> {
    const rows = [];
    for (const a of snap.appts) {
      const staff = snap.staff.find((s) => s.id === a.staff_id);
      rows.push({
        startAt: a.start_at,
        serviceName: snap.services.find((s) => s.id === a.service_id)?.name ?? "",
        staffName: staff?.name ?? "",
      });
    }
    return {
      facts: formatBookingsList(rows, snap.business.timezone),
      state: prepared.state,
      serviceId: prepared.serviceId,
      pendingAppointmentId: prepared.pendingAppointmentId,
      offerSetId: prepared.currentOfferSetId,
      intent,
    };
  }

  private async planServiceSelect(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string; serviceId: string | null },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    const byName = matchService(snap.services, parsed.service_name);
    const byOrdinal = parsed.ordinal ? snap.services[parsed.ordinal - 1] : undefined;
    const service = byName ?? byOrdinal;
    if (!service) {
      return {
        facts: formatServiceChoices(snap.services),
        state: "AWAITING_SERVICE",
        serviceId: null,
        pendingAppointmentId: null,
        offerSetId: null,
        intent: "SELECT_SERVICE",
      };
    }
    return this.planAvailability(
      ctx,
      { conversationId: prepared.conversationId, serviceId: service.id },
      { ...parsed, intent: "FIND_AVAILABILITY", confidence: 1, service_name: service.name },
      snap,
    );
  }

  private async planAvailability(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string; serviceId: string | null },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    const hinted = matchService(snap.services, parsed.service_name);
    const only = snap.services.length === 1 ? snap.services[0] : undefined;
    const remembered =
      snap.services.length === 1 ? only : snap.services.find((s) => s.id === prepared.serviceId);
    const service = hinted ?? remembered ?? only;
    if (!service) {
      return {
        facts: formatServiceChoices(snap.services),
        state: "AWAITING_SERVICE",
        serviceId: null,
        pendingAppointmentId: null,
        offerSetId: null,
        intent: "FIND_AVAILABILITY",
      };
    }
    const staffHint = parsed.staff_name
      ? snap.staff.find(
          (s) =>
            s.name.toLowerCase() === parsed.staff_name!.toLowerCase() ||
            s.name.toLowerCase().includes(parsed.staff_name!.toLowerCase()),
        )
      : undefined;
    const { from, to } = civilWindow(
      this.clock.now(),
      snap.business.timezone,
      parsed.relative_when ?? "TOMORROW",
      parsed.time_window ?? "EVENING",
      {
        ...(parsed.civil_date ? { civilDate: parsed.civil_date } : {}),
        ...(parsed.weekday ? { weekday: parsed.weekday } : {}),
        ...(parsed.time_exact ? { timeExact: parsed.time_exact } : {}),
        ...(parsed.time_from ? { timeFrom: parsed.time_from } : {}),
        ...(parsed.time_to ? { timeTo: parsed.time_to } : {}),
      },
    );
    const slots = await this.scheduling.findAvailableSlots(ctx, {
      serviceId: service.id,
      from,
      to,
      ...(staffHint ? { staffId: staffHint.id } : {}),
    });
    const capped = slots.slice(0, 5);
    if (capped.length === 0) {
      return idlePlan(FALLBACK_HE, "FIND_AVAILABILITY");
    }
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
    return {
      facts: formatAvailabilityList(
        offered.map((o) => ({ ordinal: o.ordinal, startAt: o.startAt, staffName: o.staffName })),
        snap.business.timezone,
      ),
      state: "OFFERING_SLOTS",
      serviceId: service.id,
      pendingAppointmentId: null,
      offerSetId,
      offered,
      intent: "FIND_AVAILABILITY",
    };
  }

  private async planSelectConfirm(
    ctx: TrustedTenantContext,
    prepared: { serviceId: string | null },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    const match =
      (parsed.slot_ref ? snap.open.find((s) => s.slot_ref === parsed.slot_ref) : undefined) ??
      (parsed.ordinal ? snap.open.find((s) => s.ordinal === parsed.ordinal) : undefined);
    if (!match) {
      return idlePlan(FALLBACK_HE, parsed.intent);
    }
    const staff = await withTenant(this.pool, ctx.tenantId, (c) =>
      getStaff(c, ctx.tenantId, match.staff_id),
    );
    const service = snap.services.find((s) => s.id === match.service_id);
    return {
      facts: formatBookingConfirmation({
        startAt: match.start_at,
        staffName: staff?.name ?? "",
        serviceName: service?.name ?? "",
        timeZone: snap.business.timezone,
      }),
      book: { slotRef: match.slot_ref },
      state: "IDLE",
      serviceId: null,
      pendingAppointmentId: null,
      offerSetId: null,
      intent: parsed.intent,
    };
  }

  private async planCancel(
    ctx: TrustedTenantContext,
    prepared: { pendingAppointmentId: string | null; serviceId: string | null; state: string },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    let targetId: string | undefined;
    if (parsed.ordinal && prepared.state === "AWAITING_CANCEL_CONFIRM") {
      targetId = snap.appts[parsed.ordinal - 1]?.id;
    }
    if (!targetId && snap.appts.length === 1) {
      targetId = snap.appts[0]?.id;
    }
    if (!targetId) {
      if (snap.appts.length === 0) {
        return idlePlan(NO_BOOKING_HE, "CANCEL_BOOKING");
      }
      const rows = snap.appts.map((a) => ({
        startAt: a.start_at,
        serviceName: snap.services.find((s) => s.id === a.service_id)?.name ?? "",
        staffName: snap.staff.find((s) => s.id === a.staff_id)?.name ?? "",
      }));
      return {
        facts: formatBookingsList(rows, snap.business.timezone),
        state: "AWAITING_CANCEL_CONFIRM",
        serviceId: null,
        pendingAppointmentId: null,
        offerSetId: null,
        intent: "CANCEL_BOOKING",
      };
    }
    return {
      facts: CANCELLED_HE,
      state: "IDLE",
      cancelId: targetId,
      serviceId: null,
      pendingAppointmentId: null,
      offerSetId: null,
      intent: "CANCEL_BOOKING",
    };
  }

  private async planReschedule(
    ctx: TrustedTenantContext,
    prepared: {
      conversationId: string;
      serviceId: string | null;
      pendingAppointmentId: string | null;
      state: string;
    },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    if (prepared.state === "AWAITING_RESCHEDULE_SLOT" && SLOT_SELECT_STATES.has(prepared.state)) {
      if (parsed.intent === "SELECT_SLOT" || parsed.intent === "CREATE_BOOKING") {
        return this.planRescheduleSelect(ctx, prepared, parsed, snap);
      }
    }
    if (prepared.state === "AWAITING_RESCHEDULE_APPOINTMENT" && parsed.ordinal) {
      const appt = snap.appts[parsed.ordinal - 1];
      if (!appt) {
        return idlePlan(FALLBACK_HE, "RESCHEDULE_BOOKING");
      }
      const offered = await this.planAvailability(
        ctx,
        { conversationId: prepared.conversationId, serviceId: appt.service_id },
        { ...parsed, intent: "FIND_AVAILABILITY", confidence: 1, relative_when: parsed.relative_when ?? "THIS_WEEK" },
        snap,
      );
      return {
        ...offered,
        state: "AWAITING_RESCHEDULE_SLOT",
        pendingAppointmentId: appt.id,
        serviceId: appt.service_id,
        intent: "RESCHEDULE_BOOKING",
      };
    }
    if (snap.appts.length === 0) {
      return idlePlan(NO_BOOKING_HE, "RESCHEDULE_BOOKING");
    }
    if (snap.appts.length > 1) {
      const rows = snap.appts.map((a) => ({
        startAt: a.start_at,
        serviceName: snap.services.find((s) => s.id === a.service_id)?.name ?? "",
        staffName: snap.staff.find((s) => s.id === a.staff_id)?.name ?? "",
      }));
      return {
        facts: formatBookingsList(rows, snap.business.timezone),
        state: "AWAITING_RESCHEDULE_APPOINTMENT",
        serviceId: null,
        pendingAppointmentId: null,
        offerSetId: null,
        intent: "RESCHEDULE_BOOKING",
      };
    }
    const appt = snap.appts[0]!;
    const offered = await this.planAvailability(
      ctx,
      { conversationId: prepared.conversationId, serviceId: appt.service_id },
        { ...parsed, intent: "FIND_AVAILABILITY", confidence: 1, relative_when: parsed.relative_when ?? "THIS_WEEK" },
      snap,
    );
    return {
      ...offered,
      state: "AWAITING_RESCHEDULE_SLOT",
      pendingAppointmentId: appt.id,
      serviceId: appt.service_id,
      intent: "RESCHEDULE_BOOKING",
    };
  }

  private async planRescheduleSelect(
    ctx: TrustedTenantContext,
    prepared: { pendingAppointmentId: string | null; serviceId: string | null },
    parsed: StructuredIntent,
    snap: Snapshot,
  ): Promise<Plan> {
    const match =
      (parsed.slot_ref ? snap.open.find((s) => s.slot_ref === parsed.slot_ref) : undefined) ??
      (parsed.ordinal ? snap.open.find((s) => s.ordinal === parsed.ordinal) : undefined);
    const appointmentId = prepared.pendingAppointmentId;
    if (!match || !appointmentId) {
      return {
        facts: FALLBACK_HE,
        state: "AWAITING_RESCHEDULE_SLOT",
        pendingAppointmentId: appointmentId,
        serviceId: prepared.serviceId,
        offerSetId: null,
        intent: parsed.intent,
      };
    }
    const staff = snap.staff.find((s) => s.id === match.staff_id);
    const service = snap.services.find((s) => s.id === match.service_id);
    return {
      facts: formatRescheduleConfirmation({
        startAt: match.start_at,
        staffName: staff?.name ?? "",
        serviceName: service?.name ?? "",
        timeZone: snap.business.timezone,
      }),
      state: "IDLE",
      rescheduleFromSlot: { slotRef: match.slot_ref, appointmentId },
      serviceId: null,
      pendingAppointmentId: null,
      offerSetId: null,
      intent: parsed.intent,
    };
  }
}

const WEEKDAY_LUXON: Record<"SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT", number> = {
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
  SUN: 7,
};

/** WhatsApp GET/CANCEL/RESCHEDULE only include CONFIRMED appointments with start_at > trusted now. */
export function civilWindow(
  now: Date,
  timeZone: string,
  relative: "TODAY" | "TOMORROW" | "THIS_WEEK",
  window: "MORNING" | "AFTERNOON" | "EVENING",
  extra?: {
    civilDate?: string;
    weekday?: "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
    timeExact?: string;
    timeFrom?: string;
    timeTo?: string;
  },
): { from: Date; to: Date } {
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timeZone);
  if (relative === "THIS_WEEK" && !extra?.civilDate && !extra?.weekday) {
    return { from: localNow.toUTC().toJSDate(), to: localNow.endOf("week").toUTC().toJSDate() };
  }
  let day = localNow.startOf("day");
  if (extra?.civilDate) {
    day = DateTime.fromISO(extra.civilDate, { zone: timeZone }).startOf("day");
  } else if (extra?.weekday) {
    const target = WEEKDAY_LUXON[extra.weekday];
    while (day.weekday !== target) {
      day = day.plus({ days: 1 });
    }
    if (day < localNow.startOf("day")) {
      day = day.plus({ weeks: 1 });
    }
  } else if (relative === "TOMORROW") {
    day = day.plus({ days: 1 });
  }
  const hours =
    window === "MORNING" ? ([9, 12] as const) : window === "AFTERNOON" ? ([12, 17] as const) : ([17, 21] as const);
  let from = day.set({ hour: hours[0], minute: 0, second: 0, millisecond: 0 });
  let to = day.set({ hour: hours[1], minute: 0, second: 0, millisecond: 0 });
  if (extra?.timeExact) {
    const [h, m] = extra.timeExact.split(":").map(Number);
    from = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    to = from.plus({ minutes: 30 });
  } else if (extra?.timeFrom && extra?.timeTo) {
    const [hf, mf] = extra.timeFrom.split(":").map(Number);
    const [ht, mt] = extra.timeTo.split(":").map(Number);
    from = day.set({ hour: hf, minute: mf, second: 0, millisecond: 0 });
    to = day.set({ hour: ht, minute: mt, second: 0, millisecond: 0 });
  }
  return { from: from.toUTC().toJSDate(), to: to.toUTC().toJSDate() };
}
