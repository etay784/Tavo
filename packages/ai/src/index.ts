import { z } from "zod";

export const IntentSchema = z
  .object({
    intent: z.enum([
      "FIND_AVAILABILITY",
      "SELECT_SLOT",
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
    appointment_id: z.string().uuid().optional(),
  })
  .strict();

export type StructuredIntent = z.infer<typeof IntentSchema>;

export interface AIProvider {
  extractIntent(input: { userText: string; signal?: AbortSignal }): Promise<unknown>;
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

export class FakeAIProvider implements AIProvider {
  wrapper: string | null = null;
  delayMs = 0;
  nextIntent: unknown | null = null;

  async extractIntent(input: { userText: string; signal?: AbortSignal }): Promise<unknown> {
    await wait(this.delayMs, input.signal);
    if (input.signal?.aborted) throw new Error("aborted");
    if (this.nextIntent) {
      const v = this.nextIntent;
      this.nextIntent = null;
      return v;
    }
    const t = input.userText.toLowerCase();
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
    if (t.includes("לשנות") || t.includes("לדחות") || t.includes("reschedule")) {
      return { intent: "RESCHEDULE_BOOKING", confidence: 0.9 };
    }
    if (t.includes("התור") || t.includes("התורים")) {
      return { intent: "GET_BOOKING", confidence: 0.9 };
    }
    if (/\b2\b/.test(t) || t.includes("השני") || t.includes("את השני")) {
      return { intent: "SELECT_SLOT", confidence: 0.9, ordinal: 2 };
    }
    if (/\b1\b/.test(t) || t.includes("הראשון") || t.includes("את הראשון")) {
      return { intent: "SELECT_SLOT", confidence: 0.9, ordinal: 1 };
    }
    if (t.includes("תספורת")) {
      return {
        intent: "FIND_AVAILABILITY",
        confidence: 0.9,
        relative_when: "TOMORROW",
        time_window: "EVENING",
        service_name: "תספורת",
      };
    }
    if (t.includes("מחר") || t.includes("ערב") || t.includes("משהו")) {
      return {
        intent: "FIND_AVAILABILITY",
        confidence: 0.9,
        relative_when: "TOMORROW",
        time_window: "EVENING",
      };
    }
    return { intent: "UNKNOWN", confidence: 0.4 };
  }

  async generateWrapperCopy(input: { factsBlock: string; signal?: AbortSignal }): Promise<string> {
    await wait(this.delayMs, input.signal);
    return this.wrapper ?? "";
  }
}
