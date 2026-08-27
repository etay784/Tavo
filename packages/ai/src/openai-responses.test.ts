import { describe, expect, it } from "vitest";
import { IntentSchema, type MinContext } from "./index";
import { OpenAIResponsesProvider, createAIProvider } from "./factory";

const ctx: MinContext = {
  conversation_state: "IDLE",
  timezone: "Asia/Jerusalem",
  now_civil: "2026-08-25T11:00",
  services: [{ name: "תספורת" }],
  staff: [{ name: "Daniel" }],
};

describe("OpenAI Responses adapter", () => {
  it("posts store=false strict json_schema and never uses tools", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAIResponsesProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              intent: "FIND_AVAILABILITY",
              confidence: 0.9,
              ordinal: null,
              slot_ref: null,
              time_window: "EVENING",
              relative_when: "TOMORROW",
              service_name: null,
              staff_name: null,
              civil_date: null,
              weekday: null,
              time_exact: null,
              time_from: null,
              time_to: null,
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const parsed = IntentSchema.parse(
      await provider.extractIntent({ userText: "יש תור מחר בערב?", context: ctx }),
    );
    expect(parsed.intent).toBe("FIND_AVAILABILITY");
    expect(parsed.relative_when).toBe("TOMORROW");
    const req = bodies[0] as {
      store: boolean;
      tools?: unknown;
      text: { format: { type: string; strict: boolean } };
    };
    expect(req.store).toBe(false);
    expect(req.tools).toBeUndefined();
    expect(req.text.format.type).toBe("json_schema");
    expect(req.text.format.strict).toBe(true);
    expect(await provider.generateWrapperCopy({ factsBlock: "x" })).toBe("");
  });

  it("sends already-allowlisted offered option labels from MinContext", async () => {
    let raw = "";
    const provider = new OpenAIResponsesProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      fetchImpl: async (_url, init) => {
        raw = String(init?.body);
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              intent: "SELECT_SLOT",
              confidence: 0.9,
              ordinal: 2,
              slot_ref: null,
              time_window: null,
              relative_when: null,
              service_name: null,
              staff_name: null,
              civil_date: null,
              weekday: null,
              time_exact: null,
              time_from: null,
              time_to: null,
            }),
          }),
          { status: 200 },
        );
      },
    });
    await provider.extractIntent({
      userText: "השני",
      context: {
        ...ctx,
        conversation_state: "OFFERING_SLOTS",
        offered_options: [{ ordinal: 2, label: "19:00 אצל Daniel" }],
      },
    });
    expect(raw).toContain("19:00 אצל Daniel");
    expect(raw).toContain("offered_options=");
    expect(raw).not.toMatch(/tenant_id/i);
  });

  it("does not put tenant ids or phones in the request body", async () => {
    let raw = "";
    const provider = new OpenAIResponsesProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      fetchImpl: async (_url, init) => {
        raw = String(init?.body);
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              intent: "UNKNOWN",
              confidence: 1,
              ordinal: null,
              slot_ref: null,
              time_window: null,
              relative_when: null,
              service_name: null,
              staff_name: null,
              civil_date: null,
              weekday: null,
              time_exact: null,
              time_from: null,
              time_to: null,
            }),
          }),
          { status: 200 },
        );
      },
    });
    await provider.extractIntent({ userText: "יש תור מחר?", context: ctx });
    expect(raw).not.toMatch(/tenant_id/i);
    expect(raw).not.toMatch(/9725/);
    expect(raw).not.toContain("sk-test");
  });

  it("defaults createAIProvider to FakeAI", () => {
    const ai = createAIProvider({ TAVO_AI_PROVIDER: undefined });
    expect(ai.constructor.name).toBe("FakeAIProvider");
  });
});
