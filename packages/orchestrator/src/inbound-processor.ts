import { randomBytes } from "node:crypto";
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
import { Errors, LEASE_TTL_SECONDS, ORCHESTRATOR_DEADLINE_MS } from "@tavo/shared";
import {
  attachInboundConversation,
  findCustomerByLookup,
  getBusiness,
  getInboundEvent,
  getStaff,
  insertChatMessage,
  insertOfferedSlots,
  insertOutboundMessage,
  listOpenOfferedSlots,
  listServices,
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
import { FakeAIProvider, IntentSchema, type AIProvider } from "@tavo/ai";
import {
  composeOutbound,
  FALLBACK_HE,
  formatAvailabilityList,
  formatBookingConfirmation,
} from "./formatters";

export type MessageCrypto = {
  encryptionKeyring: Keyring;
  writeVersion: number;
};

function newSlotRef(): string {
  return `slot_${randomBytes(16).toString("base64url")}`;
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
  ) {}

  async processClaimedJob(jobId: string, tenantId: string, workerId: string): Promise<void> {
    const ctx: TrustedTenantContext = {
      tenantId,
      actorType: "WHATSAPP",
      actorId: "inbound-worker",
    };
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
        workerId,
        LEASE_TTL_SECONDS,
      );
      if (!lease) {
        await markInboundFailed(client, tenantId, jobId, "conversation leased", 5);
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
        text,
        integrationId: event.integration_id,
        inboundId: jobId,
      };
    });
    if (!prepared) return;

    let plan: { facts: string; book?: { slotRef: string }; state: string; serviceId?: string };
    try {
      plan = await this.withDeadline(() => this.plan(ctx, prepared));
    } catch (e) {
      await withTenant(this.pool, tenantId, (client) =>
        markInboundFailed(client, tenantId, jobId, e instanceof Error ? e.message : "plan", 30),
      );
      return;
    }

    await withTenant(this.pool, tenantId, async (client) => {
      const still = await updateConversationState(
        client,
        tenantId,
        prepared.conversationId,
        workerId,
        prepared.lockVersion,
        { state: plan.state, serviceId: plan.serviceId ?? null },
      );
      if (!still) {
        await markInboundFailed(client, tenantId, jobId, "lost lease", 5);
        return;
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
      await markInboundProcessed(client, tenantId, jobId);
      await releaseConversationLease(
        client,
        tenantId,
        prepared.conversationId,
        workerId,
        prepared.lockVersion,
      );
    });
  }

  private messageKey(): Buffer {
    const k = this.messages.encryptionKeyring.get(this.messages.writeVersion);
    if (!k) throw new Error("message write key missing");
    return k;
  }

  private async withDeadline<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("orchestrator deadline")),
        ORCHESTRATOR_DEADLINE_MS,
      );
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async plan(
    ctx: TrustedTenantContext,
    prepared: {
      customerId: string;
      conversationId: string;
      text: string;
      inboundId: string;
    },
  ): Promise<{ facts: string; book?: { slotRef: string }; state: string; serviceId?: string }> {
    let parsed;
    try {
      parsed = IntentSchema.parse(await this.ai.extractIntent({ userText: prepared.text }));
    } catch {
      return { facts: FALLBACK_HE, state: "IDLE" };
    }
    if (parsed.intent === "UNKNOWN" || parsed.confidence < 0.5) {
      return { facts: FALLBACK_HE, state: "IDLE" };
    }
    if (parsed.intent === "FIND_AVAILABILITY") {
      return this.planAvailability(ctx, prepared, parsed.time_window, parsed.relative_when);
    }
    if (parsed.intent === "SELECT_SLOT" || parsed.intent === "CREATE_BOOKING") {
      return this.planSelect(ctx, prepared, parsed.ordinal, parsed.slot_ref);
    }
    return { facts: FALLBACK_HE, state: "IDLE" };
  }

  private async planAvailability(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string },
    window?: "MORNING" | "AFTERNOON" | "EVENING",
    relative?: "TODAY" | "TOMORROW" | "THIS_WEEK",
  ) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const business = await getBusiness(client, ctx.tenantId);
      if (!business) throw Errors.notFound("business");
      const services = await listServices(client, ctx.tenantId);
      const service = services[0];
      if (!service) return { facts: FALLBACK_HE, state: "IDLE" as const };
      const { from, to } = civilWindow(
        this.clock.now(),
        business.timezone,
        relative ?? "TOMORROW",
        window ?? "EVENING",
      );
      const slots = await this.scheduling.findAvailableSlots(ctx, {
        serviceId: service.id,
        from,
        to,
      });
      const capped = slots.slice(0, 5);
      const offered = capped.map((s, i) => ({
        slotRef: newSlotRef(),
        staffId: s.staffId,
        serviceId: service.id,
        startAt: s.startAt,
        ordinal: i + 1,
        expiresAt: new Date(Math.max(Date.now(), this.clock.now().getTime()) + 2 * 60 * 60 * 1000),
      }));
      await insertOfferedSlots(client, ctx.tenantId, prepared.conversationId, offered);
      const facts = formatAvailabilityList(
        offered.map((o, i) => ({
          ordinal: o.ordinal,
          startAt: o.startAt,
          staffName: capped[i]?.staffName ?? "",
        })),
        business.timezone,
      );
      const wrapper = await this.ai.generateWrapperCopy({ factsBlock: facts });
      return {
        facts: composeOutbound(wrapper, facts),
        state: "OFFERING_SLOTS",
        serviceId: service.id,
      };
    });
  }

  private async planSelect(
    ctx: TrustedTenantContext,
    prepared: { conversationId: string },
    ordinal?: number,
    slotRef?: string,
  ) {
    return withTenant(this.pool, ctx.tenantId, async (client) => {
      const business = await getBusiness(client, ctx.tenantId);
      const open = await listOpenOfferedSlots(client, ctx.tenantId, prepared.conversationId);
      const match =
        (slotRef ? open.find((s) => s.slot_ref === slotRef) : undefined) ??
        (ordinal ? open.find((s) => s.ordinal === ordinal) : undefined);
      if (!match || !business) {
        return { facts: FALLBACK_HE, state: "OFFERING_SLOTS" as const };
      }
      const staff = await getStaff(client, ctx.tenantId, match.staff_id);
      const services = await listServices(client, ctx.tenantId);
      const service = services.find((s) => s.id === match.service_id);
      const facts = formatBookingConfirmation({
        startAt: match.start_at,
        staffName: staff?.name ?? "",
        serviceName: service?.name ?? "",
        timeZone: business.timezone,
      });
      return {
        facts,
        book: { slotRef: match.slot_ref },
        state: "IDLE",
      };
    });
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
