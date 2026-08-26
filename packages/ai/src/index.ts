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
  })
  .strict();

export type StructuredIntent = z.infer<typeof IntentSchema>;

export interface AIProvider {
  extractIntent(input: { userText: string }): Promise<unknown>;
  generateWrapperCopy(input: { factsBlock: string }): Promise<string>;
}

export class FakeAIProvider implements AIProvider {
  wrapper: string | null = null;

  async extractIntent(input: { userText: string }): Promise<unknown> {
    const t = input.userText.toLowerCase();
    if (
      t.includes("ignore") ||
      t.includes("sql") ||
      t.includes("select *") ||
      t.includes("dump") ||
      t.includes("לקוחות") && t.includes("כל")
    ) {
      return { intent: "UNKNOWN", confidence: 0.9 };
    }
    if (t.includes("tenant_id") || t.includes("bypass")) {
      return { intent: "UNKNOWN", confidence: 0.99, tenant_id: "nope" };
    }
    if (/\b2\b/.test(t) || t.includes("השני") || t.includes("את השני")) {
      return { intent: "SELECT_SLOT", confidence: 0.9, ordinal: 2 };
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

  async generateWrapperCopy(): Promise<string> {
    return this.wrapper ?? "";
  }
}
