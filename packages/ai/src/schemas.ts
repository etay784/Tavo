import { z } from "zod";

export const RouteLabelSchema = z.enum(["BUSINESS", "UNKNOWN"]);

export type RouteClassifier = {
  classifyRoute(input: { userText: string; signal?: AbortSignal }): Promise<unknown>;
};

const nullishInt = { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] } as const;

const INTENT_ENUM = [
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
] as const;

const WEEKDAY_ENUM = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const WINDOW_ENUM = ["MORNING", "AFTERNOON", "EVENING"] as const;
const RELATIVE_ENUM = ["TODAY", "TOMORROW", "THIS_WEEK"] as const;
const civilTime = {
  anyOf: [{ type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, { type: "null" }],
} as const;
const civilDate = {
  anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }],
} as const;

/** Strict JSON Schema for OpenAI Responses Structured Outputs. All fields required; unused = null. */
export const INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: [...INTENT_ENUM] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    ordinal: nullishInt,
    slot_ref: { anyOf: [{ type: "string", pattern: "^slot_[A-Za-z0-9_-]+$" }, { type: "null" }] },
    time_window: { anyOf: [{ type: "string", enum: [...WINDOW_ENUM] }, { type: "null" }] },
    relative_when: { anyOf: [{ type: "string", enum: [...RELATIVE_ENUM] }, { type: "null" }] },
    service_name: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    staff_name: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    civil_date: civilDate,
    weekday: { anyOf: [{ type: "string", enum: [...WEEKDAY_ENUM] }, { type: "null" }] },
    time_exact: civilTime,
    time_from: civilTime,
    time_to: civilTime,
  },
  required: [
    "intent",
    "confidence",
    "ordinal",
    "slot_ref",
    "time_window",
    "relative_when",
    "service_name",
    "staff_name",
    "civil_date",
    "weekday",
    "time_exact",
    "time_from",
    "time_to",
  ],
} as const;

export const ROUTE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", enum: ["BUSINESS", "UNKNOWN"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["label", "confidence"],
} as const;

export const EVAL_MODEL_CANDIDATES = ["gpt-4.1-mini", "gpt-4.1"] as const;
