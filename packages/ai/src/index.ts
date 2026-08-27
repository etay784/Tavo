import { z } from "zod";

export const ConversationStateSchema = z.enum([
  "IDLE",
  "AWAITING_SERVICE",
  "AWAITING_STAFF",
  "OFFERING_SLOTS",
  "AWAITING_BOOK_CONFIRM",
  "AWAITING_CANCEL_CONFIRM",
  "AWAITING_RESCHEDULE_APPOINTMENT",
  "AWAITING_RESCHEDULE_SLOT",
]);

/** Real 00:00–23:59 civil clock time, not merely \d{2}:\d{2}. */
export const CivilTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y === undefined || m === undefined || d === undefined) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const CivilDateSchema = z.string().refine(isCivilDate, { message: "invalid civil_date" });

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
      "SELECT_STAFF",
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
    civil_date: CivilDateSchema.optional(),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    time_exact: CivilTimeSchema.optional(),
    time_from: CivilTimeSchema.optional(),
    time_to: CivilTimeSchema.optional(),
  })
  .strict();

export type StructuredIntent = z.infer<typeof IntentSchema>;

export const PendingRequestSchema = z
  .object({
    civil_date: CivilDateSchema.optional(),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    relative_when: z.enum(["TODAY", "TOMORROW", "THIS_WEEK"]).optional(),
    time_window: z.enum(["MORNING", "AFTERNOON", "EVENING"]).optional(),
    time_exact: CivilTimeSchema.optional(),
    time_from: CivilTimeSchema.optional(),
    time_to: CivilTimeSchema.optional(),
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

const WINDOW_MINUTES = {
  MORNING: [9 * 60, 12 * 60] as const,
  AFTERNOON: [12 * 60, 17 * 60] as const,
  EVENING: [17 * 60, 21 * 60] as const,
};

function parseHm(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function windowOverlaps(
  window: "MORNING" | "AFTERNOON" | "EVENING",
  timeFrom?: string,
  timeTo?: string,
): boolean {
  const [start, end] = WINDOW_MINUTES[window];
  const from = timeFrom ? parseHm(timeFrom) : start;
  const to = timeTo ? parseHm(timeTo) : end;
  return from < to && from < end && to > start;
}

/**
 * Canonical merge: a new date/time field replaces conflicting stored fields
 * instead of OR-ing them into an impossible constraint.
 */
export function mergePendingRequest(
  stored: PendingRequest | null | undefined,
  parsed: StructuredIntent,
): PendingRequest | null {
  const extracted = extractPendingRequest(parsed);
  if (Object.keys(extracted).length === 0) {
    return stored && Object.keys(stored).length ? { ...stored } : null;
  }
  const base: PendingRequest = { ...(stored ?? {}) };

  if (extracted.civil_date) {
    delete base.weekday;
    delete base.relative_when;
    base.civil_date = extracted.civil_date;
  } else if (extracted.weekday) {
    delete base.civil_date;
    delete base.relative_when;
    base.weekday = extracted.weekday;
  } else if (extracted.relative_when) {
    delete base.civil_date;
    delete base.weekday;
    base.relative_when = extracted.relative_when;
  }

  const hasExact = extracted.time_exact !== undefined;
  const hasWindow = extracted.time_window !== undefined;
  const hasFrom = extracted.time_from !== undefined;
  const hasTo = extracted.time_to !== undefined;

  if (hasExact) {
    base.time_exact = extracted.time_exact;
    if (!hasWindow) delete base.time_window;
    if (!hasFrom) delete base.time_from;
    if (!hasTo) delete base.time_to;
  }
  if (hasWindow) {
    base.time_window = extracted.time_window;
    if (!hasExact) delete base.time_exact;
    if (!hasFrom) delete base.time_from;
    if (!hasTo) delete base.time_to;
  }
  if (hasFrom) base.time_from = extracted.time_from;
  if (hasTo) base.time_to = extracted.time_to;
  if ((hasFrom || hasTo) && !hasExact) delete base.time_exact;

  if (base.time_from && base.time_to && parseHm(base.time_from) >= parseHm(base.time_to)) {
    if (hasFrom && !hasTo) delete base.time_to;
    else if (hasTo && !hasFrom) delete base.time_from;
  }
  if (base.time_window && (hasFrom || hasTo) && !hasWindow) {
    if (!windowOverlaps(base.time_window, base.time_from, base.time_to)) {
      delete base.time_window;
    }
  }

  if (extracted.staff_name) base.staff_name = extracted.staff_name;
  return Object.keys(base).length ? base : null;
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

function padHm(value: string): string {
  const [h, m] = value.split(":");
  return `${(h ?? "0").padStart(2, "0")}:${m ?? "00"}`;
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
  const exact =
    t.match(/בשעה\s+(\d{1,2}:\d{2})/) ??
    t.match(/exactly\s+(\d{1,2}:\d{2})/) ??
    t.match(/at\s+(\d{1,2}:\d{2})/);
  if (exact) hints.time_exact = padHm(exact[1]!);
  const after = t.match(/אחרי\s+(\d{1,2}:\d{2})/) ?? t.match(/after\s+(\d{1,2}:\d{2})/);
  const before = t.match(/לפני\s+(\d{1,2}:\d{2})/) ?? t.match(/before\s+(\d{1,2}:\d{2})/);
  if (after) hints.time_from = padHm(after[1]!);
  if (before) hints.time_to = padHm(before[1]!);
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
    if (state === "AWAITING_STAFF") {
      const named = input.context.staff.find(
        (s) => t.includes(s.name.toLowerCase()) || (s.name.toLowerCase() === "daniel" && t.includes("דניאל")),
      );
      if (named) {
        return { intent: "SELECT_STAFF", confidence: 0.9, staff_name: named.name };
      }
      const hints = availabilityHints(t, input.context);
      if (hints.time_window || hints.relative_when || hints.weekday || hints.civil_date || hints.time_from || hints.time_to) {
        return { intent: "FIND_AVAILABILITY", confidence: 0.9, ...hints };
      }
      return { intent: "CLARIFY", confidence: 0.7 };
    }
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
    if (
      t.includes("תספורת") ||
      t.includes("מחר") ||
      t.includes("ערב") ||
      t.includes("בוקר") ||
      t.includes("משהו") ||
      t.includes("לפני") ||
      t.includes("אחרי") ||
      t.includes("בעצם") ||
      t.includes("בשעה") ||
      t.includes("before") ||
      t.includes("after")
    ) {
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
