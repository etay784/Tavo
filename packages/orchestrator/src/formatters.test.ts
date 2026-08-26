import { describe, expect, it } from "vitest";
import {
  FALLBACK_HE,
  PAYMENT_UNAVAILABLE_HE,
  formatAvailabilityList,
  formatBookingConfirmation,
} from "./formatters";

describe("deterministic formatters", () => {
  it("renders civil times from instants, not from model prose", () => {
    const block = formatAvailabilityList(
      [{ ordinal: 1, startAt: new Date("2026-08-26T14:00:00.000Z"), staffName: "Daniel" }],
      "Asia/Jerusalem",
    );
    expect(block).toContain("17:00");
    expect(block).toContain("Daniel");
    expect(block).not.toContain("09:07");
  });

  it("renders booking confirmation from structured fields", () => {
    const text = formatBookingConfirmation({
      startAt: new Date("2026-08-26T14:00:00.000Z"),
      staffName: "Daniel",
      serviceName: "תספורת",
      timeZone: "Asia/Jerusalem",
    });
    expect(text).toContain("17:00");
    expect(text).toContain("Daniel");
  });

  it("does not claim a human received the message", () => {
    expect(FALLBACK_HE).not.toMatch(/הועבר|נציג|בעל העסק קיבל/);
    expect(PAYMENT_UNAVAILABLE_HE).not.toMatch(/הועבר/);
  });
});
