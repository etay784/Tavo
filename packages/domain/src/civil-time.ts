import { DateTime } from "luxon";
import type { Interval } from "./occupancy";

export function weekdaySunday0(dt: DateTime): number {
  return dt.weekday % 7;
}

export function localWorkWindow(
  civilDate: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): Interval {
  const [sh, sm] = startTime.split(":").map(Number) as [number, number];
  const [eh, em] = endTime.split(":").map(Number) as [number, number];
  const start = DateTime.fromISO(civilDate, { zone: timeZone }).set({
    hour: sh,
    minute: sm ?? 0,
    second: 0,
    millisecond: 0,
  });
  const end = DateTime.fromISO(civilDate, { zone: timeZone }).set({
    hour: eh,
    minute: em ?? 0,
    second: 0,
    millisecond: 0,
  });
  if (!start.isValid || !end.isValid) {
    throw new Error("invalid local work window");
  }
  return { start: start.toUTC().toJSDate(), end: end.toUTC().toJSDate() };
}

export function eachCivilDate(from: Date, to: Date, timeZone: string): string[] {
  const dates: string[] = [];
  let d = DateTime.fromJSDate(from, { zone: "utc" }).setZone(timeZone).startOf("day");
  const end = DateTime.fromJSDate(to, { zone: "utc" }).setZone(timeZone).startOf("day");
  while (d <= end) {
    dates.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return dates;
}
