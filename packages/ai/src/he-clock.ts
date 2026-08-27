export type ClockRelation = "AFTER" | "BEFORE" | "AROUND" | "AT";
export type DayPart = "MORNING" | "AFTERNOON" | "EVENING";

export type ParsedHeClock =
  | { kind: "civil"; relation: ClockRelation; time: string }
  | {
      kind: "twelve";
      relation: ClockRelation;
      hour: number;
      minute: number;
      window?: DayPart;
    }
  | { kind: "daypart"; window: DayPart };

const PREFIX_TO_RELATION: Record<string, ClockRelation> = {
  אחרי: "AFTER",
  לפני: "BEFORE",
  סביב: "AROUND",
  "בשעה": "AT",
  "ב-": "AT",
};

function detectDayPart(text: string): DayPart | undefined {
  if (text.includes("בוקר")) return "MORNING";
  if (text.includes("צהריים") || text.includes("אחה")) return "AFTERNOON";
  if (text.includes("ערב")) return "EVENING";
  return undefined;
}

function padHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function relationOf(prefix: string): ClockRelation {
  return PREFIX_TO_RELATION[prefix] ?? "AT";
}

/** Map a spoken 12-hour clock + daypart to 24-hour civil HH:mm. Does not use opening hours. */
export function resolveTwelveHour(hour: number, minute: number, window: DayPart): string {
  let h: number;
  if (window === "MORNING") {
    h = hour === 12 ? 0 : hour;
  } else if (window === "AFTERNOON") {
    h = hour === 12 ? 12 : hour + 12;
  } else {
    h = hour === 12 ? 0 : hour + 12;
  }
  return padHm(h % 24, minute);
}

function civilFromHour(hour: number, minute: number, relation: ClockRelation): ParsedHeClock {
  return { kind: "civil", relation, time: padHm(hour, minute) };
}

/**
 * Deterministic Hebrew clock parse. Colon times are 24-hour civil times.
 * Bare hours 1–12 without a daypart are ambiguous 12-hour clocks.
 */
export function parseHeClock(text: string): ParsedHeClock | null {
  const t = text.toLowerCase();
  const window = detectDayPart(t);
  const colon = t.match(/(אחרי|לפני|סביב|בשעה|ב-)\s*(\d{1,2}):(\d{2})/);
  if (colon) {
    const hour = Number(colon[2]);
    const minute = Number(colon[3]);
    if (hour > 23 || minute > 59) return window ? { kind: "daypart", window } : null;
    return civilFromHour(hour, minute, relationOf(colon[1]!));
  }
  const bare = t.match(/(אחרי|לפני|סביב|בשעה|ב-)\s*(\d{1,2})(?!\s*:)/);
  if (bare) {
    const hour = Number(bare[2]);
    const relation = relationOf(bare[1]!);
    if (hour > 23) return window ? { kind: "daypart", window } : null;
    if (hour === 0 || hour >= 13) {
      return civilFromHour(hour, 0, relation);
    }
    if (hour >= 1 && hour <= 12) {
      return {
        kind: "twelve",
        relation,
        hour,
        minute: 0,
        ...(window ? { window } : {}),
      };
    }
  }
  if (window) return { kind: "daypart", window };
  return null;
}

export function clockFieldsFromParse(
  clock: ParsedHeClock,
): {
  time_window?: DayPart;
  time_from?: string;
  time_to?: string;
  time_exact?: string;
  clock_hour?: number;
  clock_minute?: number;
  clock_relation?: ClockRelation;
} {
  if (clock.kind === "daypart") return { time_window: clock.window };
  const assign = (time: string) => {
    if (clock.relation === "AFTER") return { time_from: time };
    if (clock.relation === "BEFORE") return { time_to: time };
    return { time_exact: time };
  };
  if (clock.kind === "civil") return assign(clock.time);
  if (clock.window) {
    return assign(resolveTwelveHour(clock.hour, clock.minute, clock.window));
  }
  return {
    clock_hour: clock.hour,
    ...(clock.minute ? { clock_minute: clock.minute } : {}),
    clock_relation: clock.relation,
  };
}

export function overlayHeClock(parsed: unknown, userText: string): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const clock = parseHeClock(userText);
  if (!clock) return parsed;
  const fields = clockFieldsFromParse(clock);
  const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  if (clock.kind === "twelve" && !clock.window) {
    delete next["time_from"];
    delete next["time_to"];
    delete next["time_exact"];
    delete next["time_window"];
    next["clock_hour"] = fields.clock_hour;
    next["clock_relation"] = fields.clock_relation;
    if (fields.clock_minute !== undefined) next["clock_minute"] = fields.clock_minute;
    else delete next["clock_minute"];
    return next;
  }
  if (clock.kind === "civil" || clock.kind === "twelve") {
    delete next["clock_hour"];
    delete next["clock_minute"];
    delete next["clock_relation"];
    delete next["time_from"];
    delete next["time_to"];
    delete next["time_exact"];
    delete next["time_window"];
    Object.assign(next, fields);
    return next;
  }
  if (fields.time_window) next["time_window"] = fields.time_window;
  return next;
}
