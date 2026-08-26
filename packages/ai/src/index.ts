import { z } from "zod";

export const ConversationStateSchema = z.enum([
  "IDLE",
  "AWAITING_SERVICE",
  "OFFERING_SLOTS",
  "AWAITING_BOOK_CONFIRM",
  "AWAITING_CANCEL_CONFIRM",
  "AWAITING_RESCHEDULE_APPOINTMENT",
  "AWAITING_RESCHEDULE_SLOT",
]);

export const MinContextSchema = z
  .object({
    conversation_state: ConversationStateSchema,
    timezone: z.string().min(1).max(64),
    now_civil: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    services: z.array(z.object({ name: z.string().min(1).max(80) }).strict()).max(40),
    staff: z.array(z.object({ name: z.string().min(1).max(80) }).strict()).max(40),
    offered_options: z
      .array(z.object({ ordinal: z.number().int().positive(), label: z.string().max(120) }).strict())
      .max(10)
      .optional(),
    appointment_options: z
      .array(z.object({ ordinal: z.number().int().positive(), label: z.string().max(120) }).strict())
      .max(20)
      .optional(),
  })
  .strict();

export type MinContext = z.infer<typeof MinContextSchema>;

export const IntentSchema = z
  .object({
    intent: z.enum([
      "FIND_AVAILABILITY",
      "SELECT_SLOT",
      "SELECT_SERVICE",
      "CREATE_BOOKING",
      "GET_BOOKING",
      "GET_PRICE",
      "GET_BUSINESS_INFO",
      "RESCHEDULE_BOOKING",
      "CANCEL_BOOKING",
      "CLARIFY",
      "UNKNOWN",
    ]),
    confidence: z.number().min(0).max(1),
    ordinal: z.number().int().positive().optional(),
    slot_ref: z.string().regex(/^slot_[A-Za-z0-9_-]+$/).optional(),
    time_window: z.enum(["MORNING", "AFTERNOON", "EVENING"]).optional(),
    relative_when: z.enum(["TODAY", "TOMORROW", "THIS_WEEK"]).optional(),
    service_name: z.string().min(1).max(80).optional(),
    staff_name: z.string().min(1).max(80).optional(),
    civil_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    time_exact: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    time_from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    time_to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })
  .strict();

export type StructuredIntent = z.infer<typeof IntentSchema>;

export const PendingRequestSchema = z
  .object({
    civil_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    relative_when: z.enum(["TODAY", "TOMORROW", "THIS_WEEK"]).optional(),
    time_window: z.enum(["MORNING", "AFTERNOON", "EVENING"]).optional(),
    time_exact: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    time_from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    time_to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    staff_name: z.string().min(1).max(80).optional(),
  })
  .strict();

export type PendingRequest = z.infer<typeof PendingRequestSchema>;

export function extractPendingRequest(parsed: StructuredIntent): PendingRequest {
  const next: PendingRequest = {};
  if (parsed.civil_date) next.civil_date = parsed.civil_date;
  if (parsed.weekday) next.weekday = parsed.weekday;
  if (parsed.relative_when) next.relative_when = parsed.relative_when;
  if (parsed.time_window) next.time_window = parsed.time_window;
  if (parsed.time_exact) next.time_exact = parsed.time_exact;
  if (parsed.time_from) next.time_from = parsed.time_from;
  if (parsed.time_to) next.time_to = parsed.time_to;
  if (parsed.staff_name) next.staff_name = parsed.staff_name;
  return next;
}

export function mergePendingRequest(
  stored: PendingRequest | null | undefined,
  parsed: StructuredIntent,
): PendingRequest | null {
  const extracted = extractPendingRequest(parsed);
  const merged = { ...(stored ?? {}), ...extracted };
  return Object.keys(merged).length ? merged : null;
}

export type IntentExtractionInput = {
  userText: string;
  context: MinContext;
  signal?: AbortSignal;
};

export interface AIProvider {
  extractIntent(input: IntentExtractionInput): Promise<unknown>;
  generateWrapperCopy(input: { factsBlock: string; signal?: AbortSignal }): Promise<string>;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function availabilityHints(t: string, context: MinContext): Partial<StructuredIntent> {
  const hints: Partial<StructuredIntent> = {};
  if (t.includes("בוקר")) hints.time_window = "MORNING";
  else if (t.includes("צהריים") || t.includes("אחה")) hints.time_window = "AFTERNOON";
  else if (t.includes("ערב")) hints.time_window = "EVENING";
  if (t.includes("חמישי")) hints.weekday = "THU";
  else if (t.includes("שלישי")) hints.weekday = "TUE";
  else if (t.includes("רביעי")) hints.weekday = "WED";
  else if (t.includes("שישי")) hints.weekday = "FRI";
  else if (t.includes("שבת")) hints.weekday = "SAT";
  else if (t.includes("יום ראשון") || t.includes("ביום ראשון")) hints.weekday = "SUN";
  else if (t.includes("יום שני") || t.includes("ביום שני")) hints.weekday = "MON";
  const staff = context.staff.find(
    (s) => t.includes(s.name.toLowerCase()) || (s.name.toLowerCase() === "daniel" && t.includes("דניאל")),
  );
  if (staff) hints.staff_name = staff.name;
  const after = t.match(/אחרי\s+(\d{1,2}:\d{2})/) ?? t.match(/after\s+(\d{1,2}:\d{2})/);
  const before = t.match(/לפני\s+(\d{1,2}:\d{2})/) ?? t.match(/before\s+(\d{1,2}:\d{2})/);
  if (after) hints.time_from = after[1]!.padStart(5, "0");
  if (before) hints.time_to = before[1]!.padStart(5, "0");
  return hints;
}

function ordinalFromText(t: string): number | undefined {
  if (/\b2\b/.test(t) || t.includes("השני") || t.includes("את השני")) return 2;
  if (/\b1\b/.test(t) || t.includes("הראשון") || t.includes("את הראשון")) return 1;
  const m = t.match(/\b([3-9])\b/);
  if (m) return Number(m[1]);
  return undefined;
}

export class FakeAIProvider implements AIProvider {
  wrapper: string | null = null;
  delayMs = 0;
  nextIntent: unknown | null = null;

  async extractIntent(input: IntentExtractionInput): Promise<unknown> {
    await wait(this.delayMs, input.signal);
    if (input.signal?.aborted) throw new Error("aborted");
    if (this.nextIntent) {
      const v = this.nextIntent;
      this.nextIntent = null;
      return v;
    }
    const t = input.userText.toLowerCase();
    const state = input.context.conversation_state;
    if (
      t.includes("ignore") ||
      t.includes("sql") ||
      t.includes("select *") ||
      t.includes("dump") ||
      (t.includes("לקוחות") && t.includes("כל"))
    ) {
      return { intent: "UNKNOWN", confidence: 0.9 };
    }
    if (t.includes("tenant_id") || t.includes("bypass")) {
      return { intent: "UNKNOWN", confidence: 0.99, tenant_id: "nope" };
    }
    if (t.includes("מחיר") || t.includes("כמה עולה") || t.includes("price")) {
      return { intent: "GET_PRICE", confidence: 0.9 };
    }
    if (t.includes("שעות") || t.includes("כתובת") || t.includes("מידע")) {
      return { intent: "GET_BUSINESS_INFO", confidence: 0.9 };
    }
    if (t.includes("לבטל") || t.includes("ביטול")) {
      return { intent: "CANCEL_BOOKING", confidence: 0.9 };
    }
    if (t.includes("לשנות") || t.includes("לדחות") || t.includes("תזיז") || t.includes("reschedule")) {
      return {
        intent: "RESCHEDULE_BOOKING",
        confidence: 0.9,
        ...availabilityHints(t, input.context),
      };
    }
    if (t.includes("התור") || t.includes("התורים")) {
      return { intent: "GET_BOOKING", confidence: 0.9 };
    }
    const ordinal = ordinalFromText(t);
    if (state === "AWAITING_SERVICE" && (ordinal || input.context.services.some((s) => t.includes(s.name.toLowerCase())))) {
      const named = input.context.services.find((s) => t.includes(s.name.toLowerCase()));
      return {
        intent: "SELECT_SERVICE",
        confidence: 0.9,
        ...(ordinal ? { ordinal } : {}),
        ...(named ? { service_name: named.name } : {}),
      };
    }
    if (
      (state === "OFFERING_SLOTS" ||
        state === "AWAITING_BOOK_CONFIRM" ||
        state === "AWAITING_RESCHEDULE_SLOT") &&
      ordinal
    ) {
      return { intent: "SELECT_SLOT", confidence: 0.9, ordinal };
    }
    if (
      (state === "AWAITING_CANCEL_CONFIRM" || state === "AWAITING_RESCHEDULE_APPOINTMENT") &&
      ordinal
    ) {
      return { intent: "CLARIFY", confidence: 0.9, ordinal };
    }
    if (t.includes("השבוע") || t.includes("this week")) {
      return {
        intent: "FIND_AVAILABILITY",
        confidence: 0.9,
        relative_when: "THIS_WEEK",
        ...availabilityHints(t, input.context),
      };
    }
    if (t.includes("תספורת") || t.includes("מחר") || t.includes("ערב") || t.includes("בוקר") || t.includes("משהו")) {
      return {
        intent: "FIND_AVAILABILITY",
        confidence: 0.9,
        relative_when: t.includes("השבוע") || t.includes("this week") ? "THIS_WEEK" : t.includes("מחר") ? "TOMORROW" : undefined,
        ...availabilityHints(t, input.context),
        ...(t.includes("תספורת") ? { service_name: "תספורת" } : {}),
      };
    }
    if (ordinal && state === "IDLE") {
      return { intent: "UNKNOWN", confidence: 0.4 };
    }
    if (ordinal) {
      return { intent: "SELECT_SLOT", confidence: 0.9, ordinal };
    }
    return { intent: "UNKNOWN", confidence: 0.4 };
  }

  async generateWrapperCopy(input: { factsBlock: string; signal?: AbortSignal }): Promise<string> {
    await wait(this.delayMs, input.signal);
    return this.wrapper ?? "";
  }
}
