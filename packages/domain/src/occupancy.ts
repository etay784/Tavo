import { DateTime } from "luxon";
import { addMinutes } from "@tavo/shared";

export type OccupancySnapshot = {
  startAt: Date;
  endAt: Date;
  occupiedStartAt: Date;
  occupiedEndAt: Date;
};

export function occupancySnapshot(
  startAt: Date,
  durationMinutes: number,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
): OccupancySnapshot {
  const endAt = addMinutes(startAt, durationMinutes);
  const occupiedStartAt = addMinutes(startAt, -bufferBeforeMinutes);
  const occupiedEndAt = addMinutes(endAt, bufferAfterMinutes);
  return { startAt, endAt, occupiedStartAt, occupiedEndAt };
}

export type Interval = { start: Date; end: Date };

export function mergeIntervals(input: Interval[]): Interval[] {
  const sorted = [...input].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (!last || cur.start.getTime() > last.end.getTime()) {
      out.push({ start: cur.start, end: cur.end });
    } else if (cur.end.getTime() > last.end.getTime()) {
      last.end = cur.end;
    }
  }
  return out;
}

export function subtractBusy(window: Interval, busy: Interval[]): Interval[] {
  let remaining: Interval[] = [window];
  for (const b of mergeIntervals(busy)) {
    const next: Interval[] = [];
    for (const w of remaining) {
      if (b.end <= w.start || b.start >= w.end) {
        next.push(w);
        continue;
      }
      if (b.start > w.start) {
        next.push({ start: w.start, end: b.start < w.end ? b.start : w.end });
      }
      if (b.end < w.end) {
        next.push({ start: b.end > w.start ? b.end : w.start, end: w.end });
      }
    }
    remaining = next.filter((x) => x.end.getTime() > x.start.getTime());
  }
  return remaining;
}

export function slotFits(free: Interval[], occupied: Interval): boolean {
  return free.some(
    (w) =>
      occupied.start.getTime() >= w.start.getTime() &&
      occupied.end.getTime() <= w.end.getTime(),
  );
}

export function candidateStarts(
  free: Interval[],
  durationMinutes: number,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
  granularityMinutes: number,
  timeZone: string,
): Date[] {
  const starts: Date[] = [];
  for (const w of free) {
    const first = addMinutes(w.start, bufferBeforeMinutes);
    const last = addMinutes(w.end, -(durationMinutes + bufferAfterMinutes));
    if (last.getTime() < first.getTime()) continue;
    starts.push(
      ...civilGridStarts(first, last, granularityMinutes, timeZone),
    );
  }
  return starts;
}

/** Snap starts to a civil clock grid in `timeZone` (DST-aware via Luxon). */
export function civilGridStarts(
  firstInclusive: Date,
  lastInclusive: Date,
  granularityMinutes: number,
  timeZone: string,
): Date[] {
  if (granularityMinutes <= 0) {
    throw new Error("granularityMinutes must be positive");
  }
  let cursor = ceilToCivilGranularity(
    DateTime.fromJSDate(firstInclusive, { zone: "utc" }).setZone(timeZone),
    granularityMinutes,
  );
  const last = DateTime.fromJSDate(lastInclusive, { zone: "utc" }).setZone(timeZone);
  const out: Date[] = [];
  let guard = 0;
  while (cursor <= last) {
    if (cursor.isValid) {
      out.push(cursor.toUTC().toJSDate());
    }
    const next = cursor.plus({ minutes: granularityMinutes });
    if (!next.isValid || next <= cursor) {
      break;
    }
    cursor = next;
    guard += 1;
    if (guard > 20_000) {
      throw new Error("civil grid iteration overflow");
    }
  }
  return out;
}

function ceilToCivilGranularity(dt: DateTime, granularityMinutes: number): DateTime {
  const local = dt.set({ second: 0, millisecond: 0 });
  let minutesOfDay = local.hour * 60 + local.minute;
  if (dt.second > 0 || dt.millisecond > 0) {
    minutesOfDay += 1;
  }
  const aligned = Math.ceil(minutesOfDay / granularityMinutes) * granularityMinutes;
  if (aligned >= 24 * 60) {
    return local.startOf("day").plus({ days: 1 });
  }
  const hour = Math.floor(aligned / 60);
  const minute = aligned % 60;
  const snapped = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (!snapped.isValid) {
    return local.plus({ minutes: granularityMinutes }).set({ second: 0, millisecond: 0 });
  }
  return snapped;
}
