import {
  LLM_SENDER_PER_MINUTE,
  LLM_TENANT_PER_HOUR,
} from "@tavo/shared";

type Bucket = { n: number; reset: number };

const senderMinute = new Map<string, Bucket>();
const tenantHour = new Map<string, Bucket>();

function hit(map: Map<string, Bucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || now > cur.reset) {
    map.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  cur.n += 1;
  return cur.n <= limit;
}

/** Returns true if the call is within budget. */
export function consumeLlmBudget(tenantId: string, senderKey: string): boolean {
  const senderOk = hit(senderMinute, `${tenantId}:${senderKey}`, LLM_SENDER_PER_MINUTE, 60_000);
  const tenantOk = hit(tenantHour, tenantId, LLM_TENANT_PER_HOUR, 60 * 60_000);
  return senderOk && tenantOk;
}

export const LLM_BUDGET_HE = "כרגע יש עומס. נסו שוב בעוד דקה.";
