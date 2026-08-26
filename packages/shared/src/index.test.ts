import { describe, expect, it } from "vitest";
import { addMinutes, Errors, LEASE_TTL_MS, ORCHESTRATOR_DEADLINE_MS } from "./index";

describe("shared", () => {
  it("maps slot errors", () => {
    expect(Errors.slotNoLongerAvailable().code).toBe("SLOT_NO_LONGER_AVAILABLE");
  });

  it("adds minutes", () => {
    const d = new Date("2026-08-27T17:00:00.000Z");
    expect(addMinutes(d, 30).toISOString()).toBe("2026-08-27T17:30:00.000Z");
  });

  it("keeps lease TTL longer than the orchestrator deadline", () => {
    expect(LEASE_TTL_MS).toBeGreaterThan(ORCHESTRATOR_DEADLINE_MS);
  });
});
