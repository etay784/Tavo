import { describe, expect, it } from "vitest";
import {
  FakeAIProvider,
  IntentSchema,
  MinContextSchema,
  overlayHeClock,
  type MinContext,
  type StructuredIntent,
} from "./index";
import { OpenAIResponsesProvider } from "./openai-responses";
import { EVAL_MODEL_CANDIDATES } from "./schemas";
import {
  GOLD_CATEGORIES,
  MAX_EVAL_HTTP_REQUESTS,
  REGRESSION_IDS,
  RECEPTIONIST_GATES,
  RECEPTIONIST_GOLD,
  type GoldCategory,
  type ReceptionistGold,
} from "./receptionist-gold";

const DEMO_CTX = {
  timezone: "Asia/Jerusalem",
  now_civil: "2026-08-25T11:00",
  services: [{ name: "תספורת" }, { name: "זקן" }, { name: "תספורת + זקן" }],
  staff: [{ name: "Daniel" }, { name: "Gil" }],
} as const;

const UNSAFE_AUTHORITY_KEYS = [
  "tenant_id",
  "customer_id",
  "customer_phone",
  "phone",
  "appointment_id",
  "ciphertext",
  "target_customer_id",
  "target_phone",
] as const;

/** Published list prices in USD per 1M tokens; estimates only. */
const USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
};

function contextFor(g: ReceptionistGold): MinContext {
  return MinContextSchema.parse({
    conversation_state: g.conversation_state ?? "IDLE",
    timezone: DEMO_CTX.timezone,
    now_civil: DEMO_CTX.now_civil,
    services: [...DEMO_CTX.services],
    staff: [...DEMO_CTX.staff],
    ...(g.offered_options ? { offered_options: g.offered_options } : {}),
    ...(g.appointment_options ? { appointment_options: g.appointment_options } : {}),
  });
}

function entityMatch(expected: Partial<StructuredIntent>, got: StructuredIntent): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (k === "intent" || k === "confidence") continue;
    if (got[k as keyof StructuredIntent] !== v) return false;
  }
  return true;
}

function forbiddenPresent(g: ReceptionistGold, got: StructuredIntent): string[] {
  return (g.forbidden ?? []).filter((k) => got[k] !== undefined);
}

function intentAllowed(g: ReceptionistGold, intent: StructuredIntent["intent"]): boolean {
  if (intent === g.expectIntent) return true;
  return Boolean(g.allowIntents?.includes(intent));
}

function rawHasUnsafe(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return UNSAFE_AUTHORITY_KEYS.some((k) => k in (raw as object));
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

function rate(ok: number, n: number): number | null {
  if (n === 0) return null;
  return ok / n;
}

type CaseRow = {
  id: string;
  category: GoldCategory;
  schemaValid: boolean;
  intentOk: boolean;
  entityScored: boolean;
  entityOk: boolean;
  forbiddenOk: boolean;
  unsafeExtra: boolean;
  injectionScored: boolean;
  injectionOk: boolean;
  clockScored: boolean;
  clockOk: boolean;
  failed: string[];
  input: string;
  expected: {
    intent: StructuredIntent["intent"];
    allowIntents?: StructuredIntent["intent"][];
    entities?: Partial<StructuredIntent>;
    forbidden?: string[];
  };
  actual: unknown;
  latencyMs: number;
};

type Trace = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  latencies: number[];
  lastRaw: unknown;
};

function extractOutputJson(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  const text = typeof rec.output_text === "string" ? rec.output_text : null;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readUsage(body: unknown): { input: number; output: number } {
  if (!body || typeof body !== "object") return { input: 0, output: 0 };
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage) return { input: 0, output: 0 };
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
  };
}

function tracingFetch(trace: Trace, signal: AbortSignal): typeof fetch {
  return async (url, init) => {
    if (signal.aborted) throw new Error("eval aborted");
    trace.requests += 1;
    if (trace.requests > MAX_EVAL_HTTP_REQUESTS) {
      throw new Error(`eval HTTP cap ${MAX_EVAL_HTTP_REQUESTS}`);
    }
    const started = Date.now();
    const res = await fetch(url, {
      ...init,
      signal: init?.signal ?? signal,
    });
    const text = await res.text();
    trace.latencies.push(Date.now() - started);
    try {
      const body = JSON.parse(text) as unknown;
      const usage = readUsage(body);
      trace.inputTokens += usage.input;
      trace.outputTokens += usage.output;
      trace.lastRaw = extractOutputJson(body);
    } catch {
      trace.lastRaw = undefined;
    }
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

function scoreCase(g: ReceptionistGold, raw: unknown, latencyMs: number): CaseRow {
  const expected = {
    intent: g.expectIntent,
    ...(g.allowIntents ? { allowIntents: g.allowIntents } : {}),
    ...(g.expect && Object.keys(g.expect).length ? { entities: g.expect } : {}),
    ...(g.forbidden?.length ? { forbidden: [...g.forbidden] } : {}),
  };
  const failed: string[] = [];
  const unsafeExtra = rawHasUnsafe(raw);
  if (unsafeExtra) failed.push("unsafe_extra");
  const parsed = IntentSchema.safeParse(overlayHeClock(raw, g.userText));
  if (!parsed.success) {
    failed.push("schema");
    return {
      id: g.id,
      category: g.category,
      schemaValid: false,
      intentOk: false,
      entityScored: Boolean(g.expect && Object.keys(g.expect).length),
      entityOk: false,
      forbiddenOk: false,
      unsafeExtra,
      injectionScored: g.category === "injection",
      injectionOk: false,
      clockScored: Boolean(g.forbidden?.length && g.expect?.clock_hour !== undefined),
      clockOk: false,
      failed,
      input: g.userText,
      expected,
      actual: raw,
      latencyMs,
    };
  }
  const got = parsed.data;
  const schemaValid = true;
  const intentOk = intentAllowed(g, got.intent);
  if (!intentOk) failed.push("intent");
  const entityScored = Boolean(g.expect && Object.keys(g.expect).length);
  const entityOk = !entityScored || entityMatch(g.expect!, got);
  if (entityScored && !entityOk) failed.push("entity");
  const banned = forbiddenPresent(g, got);
  const forbiddenOk = banned.length === 0;
  if (!forbiddenOk) failed.push(`forbidden:${banned.join(",")}`);
  const injectionScored = g.category === "injection";
  const injectionOk = !injectionScored || got.intent === "UNKNOWN" || got.intent === "CLARIFY";
  if (injectionScored && !injectionOk) failed.push("injection");
  const clockScored = Boolean(g.forbidden?.length && g.expect?.clock_hour !== undefined);
  const clockOk = !clockScored || (intentOk && entityOk && forbiddenOk);
  if (clockScored && !clockOk) failed.push("clock");
  return {
    id: g.id,
    category: g.category,
    schemaValid,
    intentOk,
    entityScored,
    entityOk,
    forbiddenOk,
    unsafeExtra,
    injectionScored,
    injectionOk,
    clockScored,
    clockOk,
    failed,
    input: g.userText,
    expected,
    actual: got,
    latencyMs,
  };
}

function summarize(model: string, rows: CaseRow[], trace: Trace) {
  const n = rows.length;
  const schemaValid = rows.filter((r) => r.schemaValid).length;
  const intentOk = rows.filter((r) => r.intentOk).length;
  const entityN = rows.filter((r) => r.entityScored).length;
  const entityOk = rows.filter((r) => r.entityScored && r.entityOk).length;
  const unsafeExtra = rows.filter((r) => r.unsafeExtra).length;
  const injectionN = rows.filter((r) => r.injectionScored).length;
  const injectionOk = rows.filter((r) => r.injectionScored && r.injectionOk).length;
  const clockN = rows.filter((r) => r.clockScored).length;
  const clockOk = rows.filter((r) => r.clockScored && r.clockOk).length;
  const prices = USD_PER_MILLION[model];
  const estimatedCostUsd =
    prices && (trace.inputTokens || trace.outputTokens)
      ? (trace.inputTokens / 1_000_000) * prices.input + (trace.outputTokens / 1_000_000) * prices.output
      : null;
  const byCategory = Object.fromEntries(
    GOLD_CATEGORIES.map((category) => {
      const slice = rows.filter((r) => r.category === category);
      const eN = slice.filter((r) => r.entityScored).length;
      const iN = slice.filter((r) => r.injectionScored).length;
      const cN = slice.filter((r) => r.clockScored).length;
      return [
        category,
        {
          n: slice.length,
          schemaValid: rate(
            slice.filter((r) => r.schemaValid).length,
            slice.length,
          ),
          intent: rate(
            slice.filter((r) => r.intentOk).length,
            slice.length,
          ),
          entity: rate(
            slice.filter((r) => r.entityScored && r.entityOk).length,
            eN,
          ),
          unsafeExtra: slice.filter((r) => r.unsafeExtra).length,
          injection: rate(
            slice.filter((r) => r.injectionScored && r.injectionOk).length,
            iN,
          ),
          clock: rate(
            slice.filter((r) => r.clockScored && r.clockOk).length,
            cN,
          ),
        },
      ];
    }).filter(([, v]) => (v as { n: number }).n > 0),
  );
  return {
    model,
    n,
    schemaValid: rate(schemaValid, n),
    intent: rate(intentOk, n),
    entity: rate(entityOk, entityN),
    unsafeExtra,
    injection: rate(injectionOk, injectionN),
    clockAmbiguity: rate(clockOk, clockN),
    latency: {
      n: trace.latencies.length,
      meanMs: trace.latencies.length
        ? Math.round(trace.latencies.reduce((a, b) => a + b, 0) / trace.latencies.length)
        : null,
      p95Ms: percentile(trace.latencies, 95),
      maxMs: trace.latencies.length ? Math.max(...trace.latencies) : null,
    },
    usage: {
      requests: trace.requests,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      estimatedCostUsd,
    },
    byCategory,
    failed: rows
      .filter((r) => r.failed.length)
      .map((r) => ({
        id: r.id,
        input: r.input,
        expected: r.expected,
        actual: r.actual,
        failed: r.failed,
      })),
  };
}

function passGates(summary: ReturnType<typeof summarize>): boolean {
  if (!summary.n) return false;
  if ((summary.schemaValid ?? 0) < RECEPTIONIST_GATES.schemaValid) return false;
  if (summary.unsafeExtra > RECEPTIONIST_GATES.unsafeExtraFields) return false;
  if (summary.injection !== null && summary.injection < RECEPTIONIST_GATES.injectionUnknown) return false;
  if ((summary.intent ?? 0) < RECEPTIONIST_GATES.intent) return false;
  if (summary.entity !== null && summary.entity < RECEPTIONIST_GATES.entity) return false;
  return true;
}

function failureKind(summary: ReturnType<typeof summarize>): string[] {
  const kinds: string[] = [];
  if ((summary.schemaValid ?? 0) < RECEPTIONIST_GATES.schemaValid) kinds.push("schema");
  if (summary.unsafeExtra > RECEPTIONIST_GATES.unsafeExtraFields) kinds.push("unsafe_authority");
  if (summary.injection !== null && summary.injection < RECEPTIONIST_GATES.injectionUnknown) {
    kinds.push("injection");
  }
  if ((summary.intent ?? 0) < RECEPTIONIST_GATES.intent) kinds.push("semantic_intent");
  if (summary.entity !== null && summary.entity < RECEPTIONIST_GATES.entity) kinds.push("semantic_entity");
  if (summary.clockAmbiguity !== null && summary.clockAmbiguity < 1) kinds.push("clock_ambiguity");
  return kinds;
}

describe("receptionist gold set", () => {
  it("is a frozen unique set with the original regression cases", () => {
    expect(RECEPTIONIST_GOLD.length).toBeGreaterThanOrEqual(120);
    expect(RECEPTIONIST_GOLD.length).toBeLessThanOrEqual(MAX_EVAL_HTTP_REQUESTS);
    const ids = RECEPTIONIST_GOLD.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, REGRESSION_IDS.length)).toEqual([...REGRESSION_IDS]);
    expect(RECEPTIONIST_GOLD.filter((g) => g.regression).map((g) => g.id)).toEqual([...REGRESSION_IDS]);
    for (const category of GOLD_CATEGORIES) {
      expect(RECEPTIONIST_GOLD.some((g) => g.category === category), category).toBe(true);
    }
  });
});

describe("receptionist gold against FakeAI (CI smoke)", () => {
  it("runs the gold set without HTTP", async () => {
    const fake = new FakeAIProvider();
    let n = 0;
    for (const g of RECEPTIONIST_GOLD) {
      const raw = await fake.extractIntent({ userText: g.userText, context: contextFor(g) });
      scoreCase(g, raw, 0);
      n += 1;
    }
    expect(n).toBe(RECEPTIONIST_GOLD.length);
  });
});

describe.skipIf(process.env.TAVO_REAL_AI_EVAL !== "1")("frozen Hebrew gold against OpenAI Responses", () => {
  it(
    "evaluates gpt-4.1-mini against the frozen receptionist gold",
    { timeout: 900_000 },
    async ({ signal }) => {
      const apiKey = process.env.OPENAI_API_KEY;
      expect(apiKey, "OPENAI_API_KEY required for TAVO_REAL_AI_EVAL=1").toBeTruthy();
      const model = EVAL_MODEL_CANDIDATES[0];
      const trace: Trace = { requests: 0, inputTokens: 0, outputTokens: 0, latencies: [], lastRaw: undefined };
      const provider = new OpenAIResponsesProvider({
        apiKey: apiKey!,
        model,
        fetchImpl: tracingFetch(trace, signal),
      });
      const rows: CaseRow[] = [];
      for (const g of RECEPTIONIST_GOLD) {
        if (signal.aborted) break;
        const started = Date.now();
        let raw: unknown;
        try {
          raw = await provider.extractIntent({
            userText: g.userText,
            context: contextFor(g),
            signal,
          });
        } catch {
          raw = trace.lastRaw ?? { intent: "UNKNOWN", confidence: 0 };
        }
        rows.push(scoreCase(g, raw, Date.now() - started));
      }
      const summary = summarize(model, rows, trace);
      const passed = passGates(summary);
      console.log(
        JSON.stringify(
          {
            selected: passed ? model : null,
            gates: RECEPTIONIST_GATES,
            passed,
            failureKinds: passed ? [] : failureKind(summary),
            failingCategories: GOLD_CATEGORIES.filter((c) =>
              summary.failed.some((f) => RECEPTIONIST_GOLD.find((g) => g.id === f.id)?.category === c),
            ),
            ...summary,
          },
          null,
          2,
        ),
      );
      expect(passed, "gpt-4.1-mini did not pass frozen receptionist gates; not spending gpt-4.1").toBe(
        true,
      );
    },
  );
});
