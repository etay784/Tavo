import { DateTime } from "luxon";

export const FALLBACK_HE = "לא הבנתי. אפשר לכתוב מתי נוח לכם ואיזה שירות.";
export const PAYMENT_UNAVAILABLE_HE = "תשלום בצ׳אט עדיין לא זמין.";
export const PICK_SERVICE_HE = "איזה שירות?";
export const CANCELLED_HE = "התור בוטל.";
export const NO_BOOKING_HE = "לא מצאתי תור פעיל על השם הזה.";

export function formatAvailabilityList(
  slots: { ordinal: number; startAt: Date; staffName: string }[],
  timeZone: string,
): string {
  const lines = slots.map((s) => {
    const local = DateTime.fromJSDate(s.startAt, { zone: "utc" }).setZone(timeZone);
    return `${s.ordinal}) ${local.toFormat("HH:mm")} אצל ${s.staffName}`;
  });
  return ["זמין:", ...lines].join("\n");
}

export function formatBookingConfirmation(input: {
  startAt: Date;
  staffName: string;
  serviceName: string;
  timeZone: string;
}): string {
  const local = DateTime.fromJSDate(input.startAt, { zone: "utc" }).setZone(input.timeZone);
  return `התור נקבע: ${input.serviceName} אצל ${input.staffName} ב-${local.toFormat("dd/LL HH:mm")}.`;
}

export function formatPrices(services: { name: string; priceMinor: number }[]): string {
  return ["מחירים:", ...services.map((s) => `${s.name}: ₪${(s.priceMinor / 100).toFixed(0)}`)].join(
    "\n",
  );
}

export function formatServiceChoices(services: { name: string }[]): string {
  return [PICK_SERVICE_HE, ...services.map((s, i) => `${i + 1}) ${s.name}`)].join("\n");
}

export function formatBusinessInfo(input: { name: string; timeZone: string }): string {
  return `${input.name}. אזור זמן: ${input.timeZone}.`;
}

export function formatBookingsList(
  rows: { startAt: Date; serviceName: string; staffName: string }[],
  timeZone: string,
): string {
  if (rows.length === 0) return NO_BOOKING_HE;
  const lines = rows.map((r, i) => {
    const local = DateTime.fromJSDate(r.startAt, { zone: "utc" }).setZone(timeZone);
    return `${i + 1}) ${r.serviceName} אצל ${r.staffName} ב-${local.toFormat("dd/LL HH:mm")}`;
  });
  return ["התורים שלכם:", ...lines].join("\n");
}

export function formatRescheduleConfirmation(input: {
  startAt: Date;
  staffName: string;
  serviceName: string;
  timeZone: string;
}): string {
  const local = DateTime.fromJSDate(input.startAt, { zone: "utc" }).setZone(input.timeZone);
  return `התור עודכן: ${input.serviceName} אצל ${input.staffName} ב-${local.toFormat("dd/LL HH:mm")}.`;
}
