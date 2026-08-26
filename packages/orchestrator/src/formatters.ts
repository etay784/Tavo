import { DateTime } from "luxon";

export const FALLBACK_HE = "לא הבנתי. אפשר לכתוב מתי נוח לכם ואיזה שירות.";
export const PAYMENT_UNAVAILABLE_HE = "תשלום בצ׳אט עדיין לא זמין.";

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
  return services.map((s) => `${s.name}: ₪${(s.priceMinor / 100).toFixed(0)}`).join("\n");
}

export function composeOutbound(wrapper: string, factsBlock: string): string {
  const w = wrapper.trim();
  if (!w) return factsBlock;
  return `${w}\n${factsBlock}`;
}
