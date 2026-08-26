import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { occupancySnapshot, subtractBusy, candidateStarts } from "./occupancy";
import { localWorkWindow, weekdaySunday0 } from "./civil-time";

describe("occupancy snapshot", () => {
  it("includes buffers and keeps service interval inside occupancy", () => {
    const start = new Date("2026-08-27T17:00:00.000Z");
    const snap = occupancySnapshot(start, 30, 5, 10);
    expect(snap.startAt.toISOString()).toBe("2026-08-27T17:00:00.000Z");
    expect(snap.endAt.toISOString()).toBe("2026-08-27T17:30:00.000Z");
    expect(snap.occupiedStartAt.toISOString()).toBe("2026-08-27T16:55:00.000Z");
    expect(snap.occupiedEndAt.toISOString()).toBe("2026-08-27T17:40:00.000Z");
  });
});

describe("windows", () => {
  it("subtracts busy from a work window", () => {
    const free = subtractBusy(
      {
        start: new Date("2026-08-27T06:00:00.000Z"),
        end: new Date("2026-08-27T16:00:00.000Z"),
      },
      [
        {
          start: new Date("2026-08-27T10:00:00.000Z"),
          end: new Date("2026-08-27T10:30:00.000Z"),
        },
      ],
    );
    expect(free).toHaveLength(2);
    expect(free[0]?.end.toISOString()).toBe("2026-08-27T10:00:00.000Z");
    expect(free[1]?.start.toISOString()).toBe("2026-08-27T10:30:00.000Z");
  });

  it("emits UTC-zone starts on a UTC grid", () => {
    const starts = candidateStarts(
      [
        {
          start: new Date("2026-08-27T06:00:00.000Z"),
          end: new Date("2026-08-27T07:00:00.000Z"),
        },
      ],
      30,
      0,
      0,
      15,
      "UTC",
    );
    expect(starts.map((d) => d.toISOString())).toEqual([
      "2026-08-27T06:00:00.000Z",
      "2026-08-27T06:15:00.000Z",
      "2026-08-27T06:30:00.000Z",
    ]);
  });
});

describe("civil slot grid", () => {
  const zone = "Asia/Jerusalem";

  function localLabels(dates: Date[]): string[] {
    return dates.map((d) =>
      DateTime.fromJSDate(d, { zone: "utc" }).setZone(zone).toFormat("HH:mm"),
    );
  }

  it("aligns a 30-minute grid to Asia/Jerusalem wall time", () => {
    const window = localWorkWindow("2026-08-27", "09:00", "11:00", zone);
    const starts = candidateStarts([window], 30, 0, 0, 30, zone);
    expect(localLabels(starts)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("ceils off-grid local times up to the next civil slot", () => {
    const window = localWorkWindow("2026-08-27", "09:07", "10:00", zone);
    const starts = candidateStarts([window], 30, 0, 0, 30, zone);
    expect(localLabels(starts)).toEqual(["09:30"]);
  });

  it("skips the spring-forward gap so 02:00 is not a distinct civil slot", () => {
    const window = localWorkWindow("2026-03-27", "01:00", "04:00", zone);
    const starts = candidateStarts([window], 30, 0, 0, 30, zone);
    const labels = localLabels(starts);
    expect(labels[0]).toBe("01:00");
    expect(labels).toContain("01:30");
    expect(labels).toContain("03:00");
    expect(labels).not.toContain("02:00");
    expect(labels).not.toContain("02:30");
    const oneThirty = DateTime.fromJSDate(starts[1]!, { zone: "utc" }).setZone(zone);
    const afterGap = DateTime.fromJSDate(
      starts[labels.indexOf("03:00")]!,
      { zone: "utc" },
    ).setZone(zone);
    expect(oneThirty.toFormat("HH:mm")).toBe("01:30");
    expect(afterGap.toFormat("HH:mm")).toBe("03:00");
    expect(afterGap.toMillis() - oneThirty.toMillis()).toBe(30 * 60 * 1000);
  });

  it("walks both sides of the fall-back overlap as distinct UTC instants", () => {
    const window = localWorkWindow("2026-10-25", "00:00", "03:00", zone);
    const starts = candidateStarts([window], 30, 0, 0, 30, zone);
    const labels = localLabels(starts);
    expect(labels).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "01:00",
      "01:30",
      "02:00",
      "02:30",
    ]);
    const instants = starts.map((d) => d.getTime());
    expect(new Set(instants).size).toBe(instants.length);
  });
});

describe("weekday mapping", () => {
  it("maps Sunday to 0", () => {
    const sun = DateTime.fromISO("2026-08-30", { zone: "Asia/Jerusalem" });
    expect(weekdaySunday0(sun)).toBe(0);
  });
});
