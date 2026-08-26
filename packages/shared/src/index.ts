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

/** Hard abort for orchestrator/LLM/tool work. No mutation after this deadline. */
export const ORCHESTRATOR_DEADLINE_MS = 45_000;

/** Job and conversation lease TTL: deadline plus 30s margin. Must exceed ORCHESTRATOR_DEADLINE_MS. */
export const LEASE_TTL_MS = 75_000;

export const LEASE_TTL_SECONDS = LEASE_TTL_MS / 1000;
