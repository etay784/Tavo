import {
  hasCatalogName,
  hasCivilDateTokens,
  hasConsecutivePhrase,
  hasExactToken,
  hasHhMmToken,
  hasLexiconToken,
  tokenizeHe,
} from "./he-tokens";

export type RouterRoutingState = "UNKNOWN" | "BUSINESS_VERIFIED" | "PERSONAL_EXCLUDED" | "HUMAN_ONLY";

export type RouterSignals = {
  bookingAction: boolean;
  availability: boolean;
  price: boolean;
  mutation: boolean;
  service: boolean;
  staff: boolean;
  temporal: boolean;
  matchedServices: string[];
  matchedStaff: string[];
};

export type SilentRouterInput = {
  text: string;
  routingState: RouterRoutingState;
  ownerLocked: boolean;
  conversationState: string;
  serviceNames: string[];
  staffNames: string[];
  hasAppointmentHistory: boolean;
  sessionOpen?: boolean;
  classifierLabel?: "BUSINESS" | "UNKNOWN" | null;
};

export type SilentRouterDecision = {
  allowReceptionist: boolean;
  persistBusinessVerified: boolean;
  invokeClassifier: boolean;
  evidenceCodes: string[];
  action: "SILENCE" | "RECEPTIONIST";
  signals: RouterSignals;
};

const BOOKING_ACTION_TOKENS = new Set([
  "תור",
  "תורים",
  "התור",
  "התורים",
  "קבע",
  "לקבוע",
  "לבטל",
  "ביטול",
  "תבטל",
  "להזיז",
  "תזיז",
  "להקדים",
  "לאחר",
  "לשנות",
]);

const AVAILABILITY_TOKENS = new Set(["פנוי", "זמין"]);

const PRICE_TOKENS = new Set(["מחיר", "עולה"]);

const MUTATION_TOKENS = new Set(["לבטל", "ביטול", "תבטל", "להזיז", "תזיז", "להקדים", "לאחר", "לשנות"]);

const TEMPORAL_TOKENS = new Set([
  "היום",
  "מחר",
  "השבוע",
  "בוקר",
  "ערב",
  "צהריים",
  "אחה",
  "אחרי",
  "לפני",
  "סביב",
  "בבוקר",
  "בערב",
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
  "שש",
  "שבע",
  "שמונה",
  "תשע",
  "עשר",
  "אחת",
  "שתיים",
  "שלוש",
  "ארבע",
  "חמש",
]);

const STAFF_ALIASES: Record<string, string[]> = {
  daniel: ["דניאל"],
  דניאל: ["daniel"],
  gil: ["גיל"],
  גיל: ["gil"],
};

function staffPhrases(name: string): string[] {
  const n = name.trim();
  const aliases = STAFF_ALIASES[n.toLowerCase()] ?? [];
  return [n, ...aliases];
}

export function detectRouterSignals(
  text: string,
  serviceNames: string[],
  staffNames: string[],
): RouterSignals {
  const tokens = tokenizeHe(text);
  const matchedServices = serviceNames.filter((name) => hasCatalogName(tokens, name));
  const matchedStaff = staffNames.filter((name) =>
    staffPhrases(name).some((phrase) => hasCatalogName(tokens, phrase)),
  );
  const bookingAction =
    hasLexiconToken(tokens, BOOKING_ACTION_TOKENS) || hasConsecutivePhrase(tokens, "לקבוע תור");
  const availability = hasLexiconToken(tokens, AVAILABILITY_TOKENS);
  const price =
    hasLexiconToken(tokens, PRICE_TOKENS) ||
    hasConsecutivePhrase(tokens, "כמה עולה") ||
    hasExactToken(tokens, "מחיר");
  const mutation = hasLexiconToken(tokens, MUTATION_TOKENS);
  const temporal =
    hasLexiconToken(tokens, TEMPORAL_TOKENS, { allowPrefixStrip: true }) ||
    hasHhMmToken(tokens) ||
    hasCivilDateTokens(tokens);
  return {
    bookingAction,
    availability,
    price,
    mutation,
    service: matchedServices.length > 0,
    staff: matchedStaff.length > 0,
    temporal,
    matchedServices,
    matchedStaff,
  };
}

function strongComboCodes(signals: RouterSignals, hasAppointmentHistory: boolean): string[] {
  const codes: string[] = [];
  if (signals.bookingAction && signals.temporal) codes.push("booking_temporal");
  if (signals.service && signals.temporal) codes.push("service_temporal");
  if (signals.staff && signals.availability && signals.temporal) codes.push("staff_availability_temporal");
  if (signals.service && signals.price) codes.push("service_price");
  if (signals.bookingAction && signals.service) codes.push("booking_service");
  if (hasAppointmentHistory && signals.mutation) codes.push("appointment_mutation");
  return codes;
}

export function decideSilentRouter(input: SilentRouterInput): SilentRouterDecision {
  const signals = detectRouterSignals(input.text, input.serviceNames, input.staffNames);

  if (input.routingState === "PERSONAL_EXCLUDED" || input.routingState === "HUMAN_ONLY") {
    return {
      allowReceptionist: false,
      persistBusinessVerified: false,
      invokeClassifier: false,
      evidenceCodes: ["owner_block", input.routingState.toLowerCase()],
      action: "SILENCE",
      signals,
    };
  }

  if (input.routingState === "BUSINESS_VERIFIED") {
    return {
      allowReceptionist: true,
      persistBusinessVerified: false,
      invokeClassifier: false,
      evidenceCodes: ["business_verified"],
      action: "RECEPTIONIST",
      signals,
    };
  }

  if (input.sessionOpen || (input.conversationState && input.conversationState !== "IDLE")) {
    return {
      allowReceptionist: true,
      persistBusinessVerified: false,
      invokeClassifier: false,
      evidenceCodes: ["in_progress_session"],
      action: "RECEPTIONIST",
      signals,
    };
  }

  if (input.hasAppointmentHistory) {
    return {
      allowReceptionist: true,
      persistBusinessVerified: !input.ownerLocked,
      invokeClassifier: false,
      evidenceCodes: ["appointment_lifecycle"],
      action: "RECEPTIONIST",
      signals,
    };
  }

  const combos = strongComboCodes(signals, input.hasAppointmentHistory);
  if (combos.length > 0) {
    return {
      allowReceptionist: true,
      persistBusinessVerified: false,
      invokeClassifier: false,
      evidenceCodes: combos,
      action: "RECEPTIONIST",
      signals,
    };
  }

  if (input.classifierLabel === "BUSINESS") {
    return {
      allowReceptionist: true,
      persistBusinessVerified: false,
      invokeClassifier: false,
      evidenceCodes: ["classifier_business_turn"],
      action: "RECEPTIONIST",
      signals,
    };
  }

  const invokeClassifier = (signals.bookingAction || signals.service) && combos.length === 0;
  return {
    allowReceptionist: false,
    persistBusinessVerified: false,
    invokeClassifier,
    evidenceCodes: ["unknown_default_silence"],
    action: "SILENCE",
    signals,
  };
}
