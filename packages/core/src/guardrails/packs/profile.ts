import { GOOGLE_DAYS } from "../../google/client";
import { PROFILE_LIMITS } from "../../config/profile-limits";
import type { GuardrailContext, ProfileGuardFields, Rule, Severity, Violation } from "../types";

type V = Omit<Violation, "status">;

const MAX_DESCRIPTION = PROFILE_LIMITS.descriptionMaxChars.limit;
const WEEK = 7 * 1440;
const DAY_INDEX: Record<string, number> = Object.fromEntries(GOOGLE_DAYS.map((d, i) => [d, i]));

const v = (ruleId: string, severity: Severity, message: string): V => ({
  ruleId,
  packId: "profile",
  severity,
  message,
});

function rule(
  id: string,
  severity: Severity,
  description: string,
  check: (p: ProfileGuardFields, ctx: GuardrailContext) => V[],
): Rule {
  return {
    id,
    packId: "profile",
    description,
    severity,
    status: "active",
    contentTypes: ["profile"],
    check: (ctx) => (ctx.profile ? check(ctx.profile, ctx) : []),
  };
}

type Tod = { hours?: unknown; minutes?: unknown } | null | undefined;

/** Minutes since midnight, or null when invalid. 24:00 is valid (end of day) but only as 24:00. */
function minutesOf(t: Tod): number | null {
  if (typeof t !== "object" || t === null) return null;
  const h = t.hours === undefined ? 0 : t.hours;
  const m = t.minutes === undefined ? 0 : t.minutes;
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const hh = h as number;
  const mm = m as number;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59 || (hh === 24 && mm !== 0)) return null;
  return hh * 60 + mm;
}

function dayNumber(d: { year?: unknown; month?: unknown; day?: unknown } | null | undefined) {
  if (!d || !Number.isInteger(d.year) || !Number.isInteger(d.month) || !Number.isInteger(d.day)) {
    return null;
  }
  const t = Date.UTC(d.year as number, (d.month as number) - 1, d.day as number);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== d.year ||
    back.getUTCMonth() !== (d.month as number) - 1 ||
    back.getUTCDate() !== d.day
  ) {
    return null;
  }
  return Math.round(t / 86_400_000);
}

type Period = {
  openDay?: string;
  openTime?: Tod;
  closeDay?: string;
  closeTime?: Tod;
};

export function regularHoursProblems(periods: unknown[]): string[] {
  const out: string[] = [];
  const spans: { o: number; c: number; i: number }[] = [];
  periods.forEach((raw, i) => {
    const p = (raw ?? {}) as Period;
    const od = DAY_INDEX[p.openDay ?? ""];
    const cd = DAY_INDEX[p.closeDay ?? ""];
    const ot = minutesOf(p.openTime);
    const ct = minutesOf(p.closeTime);
    const n = i + 1;
    if (od === undefined || cd === undefined) {
      out.push(`Period ${n}: openDay and closeDay must be MONDAY to SUNDAY.`);
      return;
    }
    if (ot === null || ct === null || ot === 1440) {
      out.push(`Period ${n}: times must be 00:00-24:00 (24:00 only as a closing time).`);
      return;
    }
    const o = od * 1440 + ot;
    let c = cd * 1440 + ct;
    if (c <= o) {
      if (cd === od) {
        out.push(`Period ${n}: closing time must be after opening time.`);
        return;
      }
      c += WEEK; // closes in the next week, e.g. Saturday evening to Sunday morning
    }
    if (c - o > WEEK) {
      out.push(`Period ${n}: longer than a week.`);
      return;
    }
    spans.push({ o, c, i: n });
  });
  for (let a = 0; a < spans.length; a++) {
    for (let b = a + 1; b < spans.length; b++) {
      const x = spans[a]!;
      const y = spans[b]!;
      const overlaps = [-WEEK, 0, WEEK].some((s) => x.o < y.c + s && y.o + s < x.c);
      if (overlaps) out.push(`Periods ${x.i} and ${y.i} overlap.`);
    }
  }
  return out;
}

export function specialHoursProblems(periods: unknown[]): string[] {
  const out: string[] = [];
  const starts = new Set<number>();
  periods.forEach((raw, i) => {
    const p = (raw ?? {}) as {
      startDate?: Parameters<typeof dayNumber>[0];
      endDate?: Parameters<typeof dayNumber>[0];
      openTime?: Tod;
      closeTime?: Tod;
      closed?: boolean;
    };
    const n = i + 1;
    const start = dayNumber(p.startDate);
    if (start === null) {
      out.push(`Special period ${n}: startDate must be a real calendar date.`);
      return;
    }
    if (starts.has(start)) out.push(`Special period ${n}: another period starts on the same date.`);
    starts.add(start);
    if (p.closed === true) return; // end date and times are ignored by Google
    const end = p.endDate === undefined || p.endDate === null ? start : dayNumber(p.endDate);
    if (end === null || end < start || end > start + 1) {
      out.push(`Special period ${n}: endDate must be the start date or the day after.`);
      return;
    }
    const ot = minutesOf(p.openTime);
    const ct = minutesOf(p.closeTime);
    if (ot === null || ct === null || ot === 1440) {
      out.push(
        `Special period ${n}: openTime and closeTime are required (00:00-24:00) unless closed.`,
      );
      return;
    }
    const span = (end - start) * 1440 + ct - ot;
    if (span <= 0) out.push(`Special period ${n}: closing time must be after opening time.`);
    else if (span > PROFILE_LIMITS.hours.maxSpecialSpanMinutes) {
      out.push(`Special period ${n}: must span no more than 24 hours.`);
    }
  });
  return out;
}

const PHONE_CHARS = /^\+?[\d\s().-]+$/;

/** Google's own guidance: a changed address can put the location back through verification. */
const ADDRESS_REVERIFY =
  "Changing the address can send this location back to verification on Google, and it may stop showing on Maps and Search until it is verified again.";

export const profileRules: Rule[] = [
  rule(
    "PR.address-reverification",
    "warn",
    "Address changes can send the location back to verification on Google (warning, acknowledged before sending).",
    (p) =>
      p.storefrontAddress === undefined
        ? []
        : [v("PR.address-reverification", "warn", ADDRESS_REVERIFY)],
  ),
  rule(
    "PR.address-valid",
    "block",
    "Address: a region code, at most five address lines, and at least one line or a locality.",
    (p) => {
      const a = p.storefrontAddress as
        | { regionCode?: string; addressLines?: string[]; locality?: string }
        | null
        | undefined;
      if (a === undefined) return [];
      if (a === null || !a.regionCode) {
        return [v("PR.address-valid", "block", "The address needs a country (region code).")];
      }
      const lines = a.addressLines ?? [];
      if (lines.length > 5) {
        return [v("PR.address-valid", "block", "At most five address lines.")];
      }
      return lines.length === 0 && !a.locality
        ? [v("PR.address-valid", "block", "Add at least one address line or a city.")]
        : [];
    },
  ),
  rule(
    "PR.store-code-length",
    "block",
    "Store code: at most 64 characters (our own limit; Google only requires it be unique in the account).",
    (p) =>
      typeof p.storeCode === "string" && Array.from(p.storeCode).length > 64
        ? [v("PR.store-code-length", "block", "Store code is longer than 64 characters.")]
        : [],
  ),
  rule(
    "PR.description-length",
    "block",
    `Business description is longer than ${MAX_DESCRIPTION} characters (counted in Unicode code points).`,
    (p) => {
      const n = typeof p.description === "string" ? Array.from(p.description).length : 0;
      return n > MAX_DESCRIPTION
        ? [
            v(
              "PR.description-length",
              "block",
              `Description is ${n} characters; the limit is ${MAX_DESCRIPTION}.`,
            ),
          ]
        : [];
    },
  ),
  rule(
    "PR.hours-valid",
    "block",
    "Regular hours: days MONDAY-SUNDAY, times 00:00-24:00, close after open (24 hours open is 00:00 to 24:00), no overlapping periods.",
    (p) =>
      p.regularHours && Array.isArray(p.regularHours.periods)
        ? regularHoursProblems(p.regularHours.periods).map((m) => v("PR.hours-valid", "block", m))
        : [],
  ),
  rule(
    "PR.special-hours-valid",
    "block",
    "Special hours: real start dates, one period per start date, end date at most one day after start, a span of at most 24 hours, times required unless closed.",
    (p) =>
      p.specialHours && Array.isArray(p.specialHours.specialHourPeriods)
        ? specialHoursProblems(p.specialHours.specialHourPeriods).map((m) =>
            v("PR.special-hours-valid", "block", m),
          )
        : [],
  ),
  rule(
    "PR.phone-format",
    "block",
    "Phone numbers: a primary number is required, at most two additional, 7 to 15 digits; the international format (+1 415 555 0132) is preferred (warning).",
    (p) => {
      const ph = p.phoneNumbers;
      if (!ph) return [];
      const out: V[] = [];
      const additional = ph.additionalPhones ?? [];
      if (!ph.primaryPhone) out.push(v("PR.phone-format", "block", "A primary phone is required."));
      if (additional.length > PROFILE_LIMITS.additionalPhonesMax.limit) {
        out.push(
          v(
            "PR.phone-format",
            "block",
            `At most ${PROFILE_LIMITS.additionalPhonesMax.limit} additional phone numbers.`,
          ),
        );
      }
      for (const [label, num] of [
        ["Primary phone", ph.primaryPhone],
        ...additional.map((a, i) => [`Additional phone ${i + 1}`, a] as const),
      ] as const) {
        if (num === undefined || num === "") continue;
        const digits = num.replace(/\D/g, "").length;
        if (
          !PHONE_CHARS.test(num) ||
          digits < PROFILE_LIMITS.phoneDigits.min ||
          digits > PROFILE_LIMITS.phoneDigits.max
        ) {
          out.push(
            v(
              "PR.phone-format",
              "block",
              `${label} is not a valid phone number (digits, spaces, ( ) . - and a leading +; ${PROFILE_LIMITS.phoneDigits.min} to ${PROFILE_LIMITS.phoneDigits.max} digits).`,
            ),
          );
        } else if (!num.trim().startsWith("+")) {
          out.push(
            v(
              "PR.phone-format",
              "warn",
              `${label} is not in international format (+country code).`,
            ),
          );
        }
      }
      return out;
    },
  ),
];
