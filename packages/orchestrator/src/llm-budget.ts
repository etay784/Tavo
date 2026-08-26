import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { consumeLlmBudgetWindow } from "@tavo/database";
import { LLM_SENDER_PER_MINUTE, LLM_TENANT_PER_HOUR } from "@tavo/shared";

export const LLM_BUDGET_HE = "כרגע יש עומס. נסו שוב בעוד דקה.";

export function llmSenderSubject(customerId: string): string {
  return createHash("sha256").update(customerId, "utf8").digest("hex");
}

export async function consumeLlmBudget(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  now: Date,
): Promise<boolean> {
  return consumeLlmBudgetWindow(
    client,
    tenantId,
    llmSenderSubject(customerId),
    now,
    LLM_SENDER_PER_MINUTE,
    LLM_TENANT_PER_HOUR,
  );
}
