import { describe, expect, it } from "vitest";
import { tokenizeHe } from "./he-tokens";
import { decideSilentRouter, detectRouterSignals } from "./silent-router";

const DEMO_SERVICES = ["תספורת", "זקן", "תספורת + זקן"];
const DEMO_STAFF = ["Daniel", "Gil"];

type Gold = {
  id: string;
  text: string;
  bucket: "owner-personal" | "obvious-personal" | "ambiguous-personal" | "business-allow" | "unknown-silence";
  routingState?: "UNKNOWN" | "BUSINESS_VERIFIED" | "PERSONAL_EXCLUDED" | "HUMAN_ONLY";
  conversationState?: string;
  hasAppointmentHistory?: boolean;
  sessionOpen?: boolean;
  expectAllow: boolean;
  expectPersist: boolean;
};

const GOLD: Gold[] = [
  { id: "trap-torid", text: "תוריד את הסרטון", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-super", text: "אני בתור בסופר", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-football", text: "דניאל בא לכדורגל?", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-rent", text: "מחיר הדירה עלה", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-tomorrow", text: "מחר?", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-seven", text: "שבע", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-thu", text: "חמישי", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-where", text: "איפה אתה", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-time", text: "יש לך זמן?", bucket: "ambiguous-personal", expectAllow: false, expectPersist: false },
  { id: "trap-free-tmrw", text: "אתה פנוי מחר?", bucket: "ambiguous-personal", expectAllow: false, expectPersist: false },
  { id: "trap-hi", text: "היי מה קורה", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  { id: "trap-thanks", text: "תודה רבה אחי", bucket: "obvious-personal", expectAllow: false, expectPersist: false },
  {
    id: "owner-personal-business-words",
    text: "יש תור מחר?",
    bucket: "owner-personal",
    routingState: "PERSONAL_EXCLUDED",
    expectAllow: false,
    expectPersist: false,
  },
  {
    id: "owner-human",
    text: "תספורת מחר בערב",
    bucket: "owner-personal",
    routingState: "HUMAN_ONLY",
    expectAllow: false,
    expectPersist: false,
  },
  { id: "biz-tor-tmrw", text: "יש תור מחר?", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-tor-thu-eve", text: "תור בחמישי בערב?", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-cut-eve", text: "תספורת מחר בערב", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-daniel-free", text: "דניאל פנוי בחמישי?", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-beard-price", text: "כמה עולה זקן?", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-move-seven", text: "אפשר להזיז לשבע?", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-combo", text: "תספורת + זקן מחר", bucket: "business-allow", expectAllow: true, expectPersist: false },
  { id: "biz-book-service", text: "לקבוע תספורת", bucket: "business-allow", expectAllow: true, expectPersist: false },
  {
    id: "biz-history",
    text: "מה התורים",
    bucket: "business-allow",
    hasAppointmentHistory: true,
    expectAllow: true,
    expectPersist: true,
  },
  {
    id: "biz-verified-weak",
    text: "מחר?",
    bucket: "business-allow",
    routingState: "BUSINESS_VERIFIED",
    expectAllow: true,
    expectPersist: false,
  },
  {
    id: "in-progress-ordinal",
    text: "את השני",
    bucket: "business-allow",
    conversationState: "OFFERING_SLOTS",
    expectAllow: true,
    expectPersist: false,
  },
  {
    id: "zero-slot-followup",
    text: "אז בערב?",
    bucket: "business-allow",
    conversationState: "IDLE",
    sessionOpen: true,
    expectAllow: true,
    expectPersist: false,
  },
  { id: "silence-cancel-alone", text: "לבטל", bucket: "unknown-silence", expectAllow: false, expectPersist: false },
  {
    id: "silence-owner-claim",
    text: "אני בעל העסק",
    bucket: "unknown-silence",
    expectAllow: false,
    expectPersist: false,
  },
];

function run(g: Gold) {
  return decideSilentRouter({
    text: g.text,
    routingState: g.routingState ?? "UNKNOWN",
    ownerLocked: g.routingState === "PERSONAL_EXCLUDED" || g.routingState === "HUMAN_ONLY",
    conversationState: g.conversationState ?? "IDLE",
    serviceNames: DEMO_SERVICES,
    staffNames: DEMO_STAFF,
    hasAppointmentHistory: g.hasAppointmentHistory ?? false,
    sessionOpen: g.sessionOpen,
  });
}

describe("Hebrew token matching", () => {
  it("does not treat תוריד or בתור as the booking token תור", () => {
    expect(tokenizeHe("תוריד את הסרטון")).toEqual(["תוריד", "את", "הסרטון"]);
    expect(tokenizeHe("אני בתור בסופר")).toEqual(["אני", "בתור", "בסופר"]);
    const a = detectRouterSignals("תוריד את הסרטון", DEMO_SERVICES, DEMO_STAFF);
    const b = detectRouterSignals("אני בתור בסופר", DEMO_SERVICES, DEMO_STAFF);
    expect(a.bookingAction).toBe(false);
    expect(b.bookingAction).toBe(false);
  });
});

describe("Silent Router gold (no HTTP)", () => {
  it("meets frozen false-activation gates", () => {
    const byBucket = {
      "owner-personal": { n: 0, falseAllow: 0 },
      "obvious-personal": { n: 0, falseAllow: 0 },
      "ambiguous-personal": { n: 0, falseAllow: 0 },
      "business-allow": { n: 0, miss: 0 },
      "unknown-silence": { n: 0, falseAllow: 0 },
    };
    const falseActivation: string[] = [];
    for (const g of GOLD) {
      const d = run(g);
      expect(d.allowReceptionist, g.id).toBe(g.expectAllow);
      expect(d.persistBusinessVerified, g.id).toBe(g.expectPersist);
      if (g.bucket === "owner-personal") {
        byBucket["owner-personal"].n += 1;
        if (d.allowReceptionist) byBucket["owner-personal"].falseAllow += 1;
      } else if (g.bucket === "obvious-personal") {
        byBucket["obvious-personal"].n += 1;
        if (d.allowReceptionist) {
          byBucket["obvious-personal"].falseAllow += 1;
          falseActivation.push(g.id);
        }
      } else if (g.bucket === "ambiguous-personal") {
        byBucket["ambiguous-personal"].n += 1;
        if (d.allowReceptionist) {
          byBucket["ambiguous-personal"].falseAllow += 1;
          falseActivation.push(g.id);
        }
      } else if (g.bucket === "business-allow") {
        byBucket["business-allow"].n += 1;
        if (!d.allowReceptionist) byBucket["business-allow"].miss += 1;
      } else {
        byBucket["unknown-silence"].n += 1;
        if (d.allowReceptionist) byBucket["unknown-silence"].falseAllow += 1;
      }
    }
    expect(byBucket["owner-personal"].falseAllow).toBe(0);
    expect(byBucket["obvious-personal"].falseAllow).toBe(0);
    const ambRate =
      byBucket["ambiguous-personal"].n === 0
        ? 0
        : byBucket["ambiguous-personal"].falseAllow / byBucket["ambiguous-personal"].n;
    expect(ambRate).toBeLessThanOrEqual(0.01);
    expect(falseActivation).toEqual([]);
  });

  it("does not persist BUSINESS_VERIFIED from a lexical combination", () => {
    const d = run({
      id: "x",
      text: "יש תור מחר?",
      bucket: "business-allow",
      expectAllow: true,
      expectPersist: false,
    });
    expect(d.allowReceptionist).toBe(true);
    expect(d.persistBusinessVerified).toBe(false);
  });
});
