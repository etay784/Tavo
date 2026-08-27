import { describe, expect, it } from "vitest";
import { FakeAIProvider, IntentSchema, type MinContext, type StructuredIntent } from "./index";
import { OpenAIResponsesProvider } from "./openai-responses";
import { EVAL_MODEL_CANDIDATES } from "./schemas";
import { RECEPTIONIST_GATES, RECEPTIONIST_GOLD } from "./receptionist-gold";

const ctx = (state: string): MinContext => ({
  conversation_state: state as MinContext["conversation_state"],
  timezone: "Asia/Jerusalem",
  now_civil: "2026-08-25T11:00",
  services: [{ name: "תספורת" }, { name: "זקן" }, { name: "תספורת + זקן" }],
  staff: [{ name: "Daniel" }, { name: "Gil" }],
});

type Score = {
  model: string;
  n: number;
  schemaValid: number;
  unsafeExtra: number;
  injectionOk: number;
  intentOk: number;
  entityOk: number;
  entityN: number;
  injectionN: number;
};

function entityMatch(expected: Partial<StructuredIntent>, got: StructuredIntent): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (k === "intent" || k === "confidence") continue;
    if (got[k as keyof StructuredIntent] !== v) return false;
  }
  return true;
}

async function scoreProvider(
  model: string,
  extract: (userText: string, state: string) => Promise<unknown>,
): Promise<Score> {
  const score: Score = {
    model,
    n: 0,
    schemaValid: 0,
    unsafeExtra: 0,
    injectionOk: 0,
    intentOk: 0,
    entityOk: 0,
    entityN: 0,
    injectionN: 0,
  };
  for (const g of RECEPTIONIST_GOLD) {
    score.n += 1;
    const state = g.conversation_state ?? "IDLE";
    let raw: unknown;
    try {
      raw = await extract(g.userText, state);
    } catch {
      continue;
    }
    const parsed = IntentSchema.safeParse(raw);
    if (!parsed.success) {
      if (raw && typeof raw === "object" && "tenant_id" in (raw as object)) score.unsafeExtra += 1;
      continue;
    }
    score.schemaValid += 1;
    if (g.bucket === "injection") {
      score.injectionN += 1;
      if (parsed.data.intent === "UNKNOWN" || parsed.data.intent === "CLARIFY") score.injectionOk += 1;
    }
    if (parsed.data.intent === g.expectIntent) score.intentOk += 1;
    if (g.expect && Object.keys(g.expect).length) {
      score.entityN += 1;
      if (entityMatch(g.expect, parsed.data)) score.entityOk += 1;
    }
  }
  return score;
}

function passGates(s: Score): boolean {
  if (s.n === 0) return false;
  if (s.schemaValid / s.n < RECEPTIONIST_GATES.schemaValid) return false;
  if (s.unsafeExtra > RECEPTIONIST_GATES.unsafeExtraFields) return false;
  if (s.injectionN && s.injectionOk / s.injectionN < RECEPTIONIST_GATES.injectionUnknown) return false;
  if (s.intentOk / s.n < RECEPTIONIST_GATES.intent) return false;
  if (s.entityN && s.entityOk / s.entityN < RECEPTIONIST_GATES.entity) return false;
  return true;
}

describe("receptionist gold against FakeAI (CI smoke)", () => {
  it("runs the gold set without HTTP", async () => {
    const fake = new FakeAIProvider();
    const s = await scoreProvider("FakeAIProvider", (text, state) =>
      fake.extractIntent({ userText: text, context: ctx(state) }),
    );
    expect(s.n).toBe(RECEPTIONIST_GOLD.length);
  });
});

describe.skipIf(process.env.TAVO_REAL_AI_EVAL !== "1")("frozen Hebrew gold against OpenAI Responses", () => {
  it(
    "selects the first candidate model that passes receptionist gates",
    { timeout: 180_000 },
    async ({ signal }) => {
      const apiKey = process.env.OPENAI_API_KEY;
      expect(apiKey, "OPENAI_API_KEY required for TAVO_REAL_AI_EVAL=1").toBeTruthy();
      const results: Score[] = [];
      let selected: Score | undefined;
      for (const model of EVAL_MODEL_CANDIDATES) {
        if (signal.aborted) break;
        const provider = new OpenAIResponsesProvider({ apiKey: apiKey!, model });
        const s = await scoreProvider(model, (text, state) =>
          provider.extractIntent({ userText: text, context: ctx(state), signal }),
        );
        results.push(s);
        if (passGates(s)) {
          selected = s;
          break;
        }
      }
      console.log(JSON.stringify({ selected: selected?.model ?? null, results }, null, 2));
      expect(selected, "no candidate passed receptionist gates").toBeTruthy();
    },
  );
});
