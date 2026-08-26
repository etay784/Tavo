export type TrustedTenantContext = {
  tenantId: string;
  actorType: string;
  actorId: string;
};

export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const Errors = {
  slotNoLongerAvailable: () =>
    new DomainError(
      "SLOT_NO_LONGER_AVAILABLE",
      "That time is no longer available.",
      409,
    ),
  notFound: (what: string) =>
    new DomainError("NOT_FOUND", `${what} was not found.`, 404),
  validation: (message: string) =>
    new DomainError("VALIDATION", message, 400),
  unauthorized: () =>
    new DomainError("UNAUTHORIZED", "Authentication required.", 401),
  forbidden: () =>
    new DomainError("FORBIDDEN", "Not allowed.", 403),
  conflict: (message: string) =>
    new DomainError("CONFLICT", message, 409),
};

export type Clock = {
  now: () => Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23P01"
  );
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
