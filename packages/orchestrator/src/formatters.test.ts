import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { civilWindow, slotInLocalMinutes } from "./inbound-processor";
import {
  FALLBACK_HE,
  PAYMENT_UNAVAILABLE_HE,
  formatAvailabilityList,
  formatBookingConfirmation,
  formatClockClarification,
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

  it("asks morning vs evening for an ambiguous 12-hour clock", () => {
    expect(formatClockClarification({ relation: "AFTER", hour: 7 })).toBe(
      "התכוונת אחרי 7 בבוקר או אחרי 7 בערב?",
    );
    expect(formatClockClarification({ relation: "AT", hour: 8 })).toBe(
      "התכוונת ב-8 בבוקר או ב-8 בערב?",
    );
    expect(formatClockClarification({ relation: "BEFORE", hour: 8 })).toBe(
      "התכוונת לפני 8 בבוקר או לפני 8 בערב?",
    );
    expect(formatClockClarification({ relation: "AROUND", hour: 9 })).toBe(
      "התכוונת סביב 9 בבוקר או סביב 9 בערב?",
    );
  });
});

describe("civilWindow", () => {
  it("treats THIS_WEEK as the remaining Israeli week, not TODAY", () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const week = civilWindow(now, "Asia/Jerusalem", "THIS_WEEK", "EVENING");
    const today = civilWindow(now, "Asia/Jerusalem", "TODAY", "EVENING");
    expect(week.to.getTime()).toBeGreaterThan(today.to.getTime());
    expect(week.from.getTime()).toBe(now.getTime());
    expect(week.minuteFrom).toBe(17 * 60);
    expect(week.minuteTo).toBe(21 * 60);
  });

  it("keeps EVENING on THIS_WEEK and ends the week on Saturday", () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const week = civilWindow(now, "Asia/Jerusalem", "THIS_WEEK", "EVENING");
    const localEnd = DateTime.fromJSDate(week.to, { zone: "utc" }).setZone("Asia/Jerusalem");
    expect(localEnd.weekday).toBe(6);
    expect(week.minuteFrom).toBe(17 * 60);
  });

  it("includes Sunday when THIS_WEEK starts on Sunday", () => {
    const sunday = new Date("2026-08-23T08:00:00.000Z");
    const week = civilWindow(sunday, "Asia/Jerusalem", "THIS_WEEK", "EVENING");
    expect(week.from.getTime()).toBe(sunday.getTime());
    const localFrom = DateTime.fromJSDate(week.from, { zone: "utc" }).setZone("Asia/Jerusalem");
    expect(localFrom.weekday).toBe(7);
  });

  it("applies time_from only without dropping it", () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const w = civilWindow(now, "Asia/Jerusalem", "TODAY", "EVENING", { timeFrom: "18:30" });
    const localFrom = DateTime.fromJSDate(w.from, { zone: "utc" }).setZone("Asia/Jerusalem");
    expect(localFrom.toFormat("HH:mm")).toBe("18:30");
    expect(w.minuteFrom).toBe(18 * 60 + 30);
    expect(w.minuteTo).toBe(21 * 60);
  });

  it("applies time_to only without dropping it", () => {
    const now = new Date("2026-08-25T06:00:00.000Z");
    const w = civilWindow(now, "Asia/Jerusalem", "TODAY", "MORNING", { timeTo: "11:00" });
    const localTo = DateTime.fromJSDate(w.to, { zone: "utc" }).setZone("Asia/Jerusalem");
    expect(localTo.toFormat("HH:mm")).toBe("11:00");
    expect(w.minuteFrom).toBe(9 * 60);
    expect(w.minuteTo).toBe(11 * 60);
  });

  it("does not imply EVENING for a time_from-only request", () => {
    const w = civilWindow(new Date("2026-08-25T08:00:00.000Z"), "Asia/Jerusalem", "TOMORROW", undefined, {
      timeFrom: "10:00",
    });
    expect(w.minuteFrom).toBe(10 * 60);
    expect(w.minuteTo).toBe(24 * 60);
  });

  it("does not imply a morning band for a time_to-only request", () => {
    const w = civilWindow(new Date("2026-08-25T08:00:00.000Z"), "Asia/Jerusalem", "TOMORROW", undefined, {
      timeTo: "12:00",
    });
    expect(w.minuteFrom).toBe(0);
    expect(w.minuteTo).toBe(12 * 60);
  });

  it("treats time_exact as the slot start, not a 30-minute window", () => {
    const w = civilWindow(new Date("2026-08-25T08:00:00.000Z"), "Asia/Jerusalem", "TOMORROW", undefined, {
      timeExact: "18:30",
    });
    expect(w.minuteFrom).toBe(18 * 60 + 30);
    expect(w.minuteTo).toBe(18 * 60 + 31);
    expect(w.to.getTime() - w.from.getTime()).toBeGreaterThan(60_000);
  });

  it("does not treat THIS_WEEK evening as morning", () => {
    const week = civilWindow(new Date("2026-08-25T08:00:00.000Z"), "Asia/Jerusalem", "THIS_WEEK", "EVENING");
    const morning = new Date("2026-08-26T06:00:00.000Z");
    const evening = new Date("2026-08-26T15:00:00.000Z");
    expect(slotInLocalMinutes(morning, "Asia/Jerusalem", week.minuteFrom, week.minuteTo)).toBe(false);
    expect(slotInLocalMinutes(evening, "Asia/Jerusalem", week.minuteFrom, week.minuteTo)).toBe(true);
  });
});
