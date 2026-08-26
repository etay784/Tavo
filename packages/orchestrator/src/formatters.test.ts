import { describe, expect, it } from "vitest";
import { civilWindow } from "./inbound-processor";
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

describe("civilWindow", () => {
  it("treats THIS_WEEK as the remaining week, not TODAY", () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const week = civilWindow(now, "Asia/Jerusalem", "THIS_WEEK", "EVENING");
    const today = civilWindow(now, "Asia/Jerusalem", "TODAY", "EVENING");
    expect(week.to.getTime()).toBeGreaterThan(today.to.getTime());
    expect(week.from.getTime()).toBe(now.getTime());
  });
});
