import { describe, expect, it } from "vitest";
import { addMinutes, Errors } from "./index";

describe("shared", () => {
  it("maps slot errors", () => {
    expect(Errors.slotNoLongerAvailable().code).toBe("SLOT_NO_LONGER_AVAILABLE");
  });

  it("adds minutes", () => {
    const d = new Date("2026-08-27T17:00:00.000Z");
    expect(addMinutes(d, 30).toISOString()).toBe("2026-08-27T17:30:00.000Z");
  });
});
