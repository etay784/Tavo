import { describe, expect, it } from "vitest";
import {
  clockFieldsFromParse,
  overlayHeClock,
  parseHeClock,
  resolveTwelveHour,
} from "./he-clock";

describe("parseHeClock", () => {
  it("treats bare 12-hour hours as ambiguous without a daypart", () => {
    expect(parseHeClock("אחרי 7")).toEqual({
      kind: "twelve",
      relation: "AFTER",
      hour: 7,
      minute: 0,
    });
    expect(parseHeClock("ב-7")).toEqual({ kind: "twelve", relation: "AT", hour: 7, minute: 0 });
    expect(parseHeClock("לפני 8")).toEqual({
      kind: "twelve",
      relation: "BEFORE",
      hour: 8,
      minute: 0,
    });
    expect(parseHeClock("סביב 9")).toEqual({
      kind: "twelve",
      relation: "AROUND",
      hour: 9,
      minute: 0,
    });
    expect(parseHeClock("ב-8")).toEqual({ kind: "twelve", relation: "AT", hour: 8, minute: 0 });
  });

  it("resolves a daypart on the same turn without using opening hours", () => {
    expect(clockFieldsFromParse(parseHeClock("אחרי 7 בערב")!)).toEqual({ time_from: "19:00" });
    expect(clockFieldsFromParse(parseHeClock("אחרי 7 בבוקר")!)).toEqual({ time_from: "07:00" });
    expect(resolveTwelveHour(7, 0, "EVENING")).toBe("19:00");
    expect(resolveTwelveHour(7, 0, "MORNING")).toBe("07:00");
  });

  it("treats HH:mm and 13–23 as 24-hour civil time", () => {
    expect(parseHeClock("אחרי 19:00")).toEqual({
      kind: "civil",
      relation: "AFTER",
      time: "19:00",
    });
    expect(clockFieldsFromParse(parseHeClock("אחרי 19:00")!)).toEqual({ time_from: "19:00" });
    expect(clockFieldsFromParse(parseHeClock("ב-20:00")!)).toEqual({ time_exact: "20:00" });
    expect(clockFieldsFromParse(parseHeClock("אחרי 10:00")!)).toEqual({ time_from: "10:00" });
  });

  it("does not guess AM/PM when overlaying a model that emitted 07:00 for אחרי 7", () => {
    const overlaid = overlayHeClock(
      { intent: "FIND_AVAILABILITY", confidence: 1, time_from: "07:00" },
      "אחרי 7",
    ) as { time_from?: string; clock_hour?: number; clock_relation?: string };
    expect(overlaid.time_from).toBeUndefined();
    expect(overlaid.clock_hour).toBe(7);
    expect(overlaid.clock_relation).toBe("AFTER");
  });

  it("does not keep a model daypart guess for a bare 12-hour clock", () => {
    const overlaid = overlayHeClock(
      { intent: "FIND_AVAILABILITY", confidence: 1, time_window: "EVENING", time_from: "19:00" },
      "אחרי 7",
    ) as { time_from?: string; time_window?: string; clock_hour?: number };
    expect(overlaid.time_from).toBeUndefined();
    expect(overlaid.time_window).toBeUndefined();
    expect(overlaid.clock_hour).toBe(7);
  });
});
