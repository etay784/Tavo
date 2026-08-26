import { DateTime } from "luxon";

export const FALLBACK_HE = "לא הבנתי. אפשר לכתוב מתי נוח לכם ואיזה שירות.";
export const PAYMENT_UNAVAILABLE_HE = "תשלום בצ׳אט עדיין לא זמין.";
export const PICK_SERVICE_HE = "איזה שירות?";
export const CANCELLED_HE = "התור בוטל.";
export const NO_BOOKING_HE = "לא מצאתי תור פעיל על השם הזה.";
export const SLOT_UNAVAILABLE_HE = "השעה הזו כבר לא פנויה.";
export const CLARIFY_STAFF_HE = "לא מצאתי איש צוות בשם הזה. אפשר לכתוב את השם המלא?";
export const AMBIGUOUS_STAFF_HE = "יש כמה אנשי צוות דומים. אפשר לכתוב את השם המלא?";
export const CLARIFY_SERVICE_HE = "לא מצאתי שירות בשם הזה. אפשר לבחור מהרשימה?";
export const AMBIGUOUS_SERVICE_HE = "יש כמה שירותים דומים. אפשר לבחור מספר מהרשימה?";

export function formatOfferedOptionLabel(
  startAt: Date,
  staffName: string,
  timeZone: string,
): string {
  const local = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(timeZone);
  return `${local.toFormat("HH:mm")} אצל ${staffName}`;
}

export function formatAppointmentOptionLabel(input: {
  startAt: Date;
  serviceName: string;
  staffName: string;
  timeZone: string;
}): string {
  const local = DateTime.fromJSDate(input.startAt, { zone: "utc" }).setZone(input.timeZone);
  return `${input.serviceName} אצל ${input.staffName} ב-${local.toFormat("dd/LL HH:mm")}`;
}

export function formatAvailabilityList(
  slots: { ordinal: number; startAt: Date; staffName: string }[],
  timeZone: string,
): string {
  const lines = slots.map(
    (s) => `${s.ordinal}) ${formatOfferedOptionLabel(s.startAt, s.staffName, timeZone)}`,
  );
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
  const lines = rows.map(
    (r, i) => `${i + 1}) ${formatAppointmentOptionLabel({ ...r, timeZone })}`,
  );
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
