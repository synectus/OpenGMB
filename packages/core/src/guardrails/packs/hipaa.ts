import {
  compileLexicon,
  compileLiteral,
  findMatches,
  maskPhrase,
  normalise,
  tokenise,
  type TextMatch,
} from "../text";
import type { GuardrailContext, Rule, Violation } from "../types";
import { say } from "./wording";

type V = Omit<Violation, "status">;

/** Playbook H4. Source: the internal GBP reply playbook (v1, 2026-09-27). */
export const PRIVACY_LINE =
  "To protect everyone's privacy we can't discuss details here, but we'd like to hear from you.";

/**
 * H3 (keywords only as general statements, never tied to the reviewer) cannot be checked
 * mechanically beyond H1 and H2: a keyword used generically and one tied to a reviewer differ only
 * in meaning. Replies that mention a clinical term at all are blocked by H2.clinical, which is the
 * conservative reading. H5 is this pack. H6 and H7 are process and reference items with no rule.
 */
export const docs = [
  {
    id: "H3",
    summary:
      "Keywords only as general statements about the practice, never tied to the reviewer. Not mechanically checkable; covered by H1 (care-relationship phrasing) and H2 (names, clinical terms, dates).",
  },
  {
    id: "H5",
    summary:
      "Every medical reply passes an automated PHI-risk scan (H1/H2 terms) before it is published. This pack is that scan; the engine runs it at submit and again immediately before every Google write.",
  },
  {
    id: "H6",
    summary:
      "Texas HB 300: audit trail required (covered by the audit log); staff training and BAAs are process, not code. No rule.",
  },
  {
    id: "H7",
    summary:
      "Enforcement references (Elite Dental 2019, Igbinadolor 2022, New Vision Dental 2022, Manasa Health 2023): documentation only. No rule.",
  },
] as const;

/** H1: confirming or implying a care relationship. Every entry needs a second-person tie-in. */
const H1_RE = compileLexicon([
  "thank(s| you)( so much| very much)? for (visiting|coming in|coming by|stopping by|stopping in|choosing (us|our)|trusting (us|our))",
  "thank(s| you) for (being|becoming) (a|our) patient",
  "glad you('re| are| were)? (feeling|doing) (better|well|great)",
  "glad you (came|visited|chose|trusted|stopped by)",
  "hope you('re| are)? (feeling|doing) (better|well)",
  "hope you feel (better|well)",
  "(see|seeing) you (at|for|on|during) your",
  "welcome (to the family|back)",
  "your (next |upcoming |last |recent |first )?(visits?|appointments?)",
  "your (treatments?|recovery|accidents?|care|procedures?|surgery|injur(y|ies)|conditions?|therapy|adjustments?|exams?|sessions?|diagnosis|progress|healing|rehab|pain)",
  "(when|while) you (came|were) (in|here|with us)",
  "(as|being) (a|our) patient",
  "you('re| are) one of our patients",
  "(great|nice) to see you",
  "we enjoyed (having|seeing|treating) you",
  "(treated|treating) you",
]);

/** H2: conditions, treatments, accidents, attorneys, insurance, billing. */
const LEXICON_ENTRIES = [
  // conditions and injuries
  "back pain",
  "neck pain",
  "knee pain",
  "shoulder pain",
  "hip pain",
  "joint pain",
  "chronic pain",
  "whiplash",
  "sciatica",
  "herniated( disc)?",
  "slipped disc",
  "fractures?|fractured",
  "sprain(s|ed)?",
  "concussions?",
  "injur(y|ies|ed)",
  "migraines?",
  "arthritis",
  "scoliosis",
  "pinched nerve",
  "carpal tunnel",
  "cancer",
  "diabetes",
  "depression",
  "anxiety",
  "pregnan(t|cy)",
  // treatments and procedures
  "surgery|surgical",
  "x(-| )?rays?",
  "mris?",
  "ct scans?",
  "ultrasound",
  "chiropractic adjustments?",
  "spinal adjustments?",
  "physical therapy sessions?",
  "massage therapy",
  "injections?",
  "epidurals?",
  "prescriptions?",
  "medications?",
  "diagnos(is|ed)",
  "treatment plans?",
  "root canals?",
  "extractions?",
  "cavit(y|ies)",
  // accidents
  "accidents?",
  "car (crash|wreck)",
  "collisions?",
  "slip and fall",
  "rear(-| )ended",
  // attorneys, insurance, billing
  "attorneys?",
  "lawyers?",
  "insurance",
  "claims?",
  "bill(s|ing|ed)?",
  "co(-| )?pays?",
  "deductibles?",
  "invoices?",
  "balance due",
  "payment plans?",
  "out(-| )of(-| )pocket",
];
const LEXICON_RE = compileLexicon(LEXICON_ENTRIES);

const MONTHS =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?";
const DATE_WORD_RE = compileLexicon([
  "(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)",
  `${MONTHS} \\d{1,2}(st|nd|rd|th)?`,
  `\\d{1,2}(st|nd|rd|th)? (of )?${MONTHS}`,
]);
const DATE_NUMERIC_RES = [
  // 3/14 or 3/14/2026; a hyphenated form needs all three parts so "open 9-5" is not a date.
  /(?<![\d/-])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/-])/gu,
  /(?<![\d/-])\d{1,2}-\d{1,2}-\d{2,4}(?![\d/-])/gu,
  /(?<![\d-])(?:19|20)\d{2}-\d{2}-\d{2}(?![\d-])/gu,
];

const PROVIDER_RE =
  /(?<![\p{L}\p{N}])(?:[Dd][Rr]|[Dd][Oo][Cc][Tt][Oo][Rr])\.?\s+\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)?/gu;

const REBUTTAL_RE = compileLexicon([
  "never happened",
  "didn't happen",
  "did not happen",
  "that's not true",
  "that is not true",
  "this is not true",
  "untrue",
  "that's false",
  "this is false",
  "you('re| are) lying",
  "liar",
  "we have no records?( of)?",
  "(false|fake) review",
]);

/** The location's own name is exempt: a clinic called "Car Accident Care" may say so. */
function scrubbed(ctx: GuardrailContext): string {
  return maskPhrase(ctx.reply, ctx.location.name);
}

function violation(
  id: string,
  severity: "block" | "warn",
  message: string,
  matches?: TextMatch[],
): V {
  return matches
    ? { ruleId: id, packId: "hipaa", severity, message, matches }
    : { ruleId: id, packId: "hipaa", severity, message };
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function containsPhone(reply: string, phone: string): boolean {
  const want = digitsOf(phone);
  if (want.length < 7) return false;
  for (const cand of reply.match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) {
    const got = digitsOf(cand);
    if (got === want) return true;
    if (got.length >= 7 && want.endsWith(got)) return true;
    if (got.endsWith(want)) return true;
  }
  return false;
}

/** Name tokens of the reviewer: >= 2 characters, deduplicated, `A Google User` ignored. */
function reviewerTokens(name: string | null): string[] {
  if (!name || /^\s*a google user\s*$/i.test(name)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenise(name)) {
    if (t.token.length < 2 || seen.has(t.token)) continue;
    seen.add(t.token);
    out.push(name.slice(t.start, t.end));
  }
  return out;
}

function sortedByStart(ms: TextMatch[]): TextMatch[] {
  return [...ms].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * H2.echo: a run of 2 or more words copied verbatim from the review into the reply, where the run
 * contains a lexicon term ("lower back pain" echoes even though only "back pain" is in the lexicon).
 * Longest runs win; shorter runs overlapping a longer one are dropped.
 */
function echoMatches(reply: string, review: string): TextMatch[] {
  const rev = tokenise(review);
  const rep = tokenise(reply);
  const MAX_N = 8;
  const found: TextMatch[] = [];
  const claimed = new Set<number>();
  for (let n = Math.min(MAX_N, rev.length); n >= 2; n--) {
    for (let i = 0; i + n <= rev.length; i++) {
      const gram = rev.slice(i, i + n).map((t) => t.token);
      const gramText = review.slice(rev[i]!.start, rev[i + n - 1]!.end);
      if (findMatches(gramText, LEXICON_RE).length === 0) continue;
      for (let j = 0; j + n <= rep.length; j++) {
        if (rep.slice(j, j + n).some((t, k) => t.token !== gram[k])) continue;
        if (Array.from({ length: n }, (_, k) => j + k).some((x) => claimed.has(x))) continue;
        for (let k = 0; k < n; k++) claimed.add(j + k);
        const start = rep[j]!.start;
        const end = rep[j + n - 1]!.end;
        found.push({ text: reply.slice(start, end), start, end });
      }
    }
  }
  return sortedByStart(found);
}

export const hipaaRules: Rule[] = [
  {
    id: "H1",
    packId: "hipaa",
    contentTypes: ["reply", "post"],
    description:
      "Never confirm or imply a care relationship (playbook H1): thanks for visiting, glad you're feeling better, your appointment/care/recovery/accident. Requires a second-person tie-in, so generic statements like 'we care about our community' pass.",
    severity: "block",
    status: "active",
    check(ctx) {
      const matches = findMatches(scrubbed(ctx), H1_RE);
      if (matches.length === 0) return [];
      return [
        violation(
          "H1",
          "block",
          say(ctx, {
            reply: "Reply confirms or implies a care relationship with the reviewer.",
            post: "The post confirms or implies a care relationship with the reader.",
          }),
          matches,
        ),
      ];
    },
  },
  {
    id: "H2.reviewer",
    packId: "hipaa",
    description:
      "Reply contains the reviewer's name (first or last, case-insensitive; playbook H2).",
    severity: "block",
    status: "active",
    check(ctx) {
      const matches: TextMatch[] = [];
      for (const tok of reviewerTokens(ctx.review.reviewerDisplayName)) {
        matches.push(...findMatches(ctx.reply, compileLiteral(tok)));
      }
      if (matches.length === 0) return [];
      return [
        violation(
          "H2.reviewer",
          "block",
          "Reply contains the reviewer's name.",
          sortedByStart(matches),
        ),
      ];
    },
  },
  {
    id: "H2.provider",
    packId: "hipaa",
    contentTypes: ["reply", "post"],
    description: "Reply names a provider as 'Dr./Doctor <Name>' (playbook H2).",
    severity: "block",
    status: "active",
    check(ctx) {
      const matches = findMatches(scrubbed(ctx), PROVIDER_RE);
      if (matches.length === 0) return [];
      return [violation(
          "H2.provider",
          "block",
          say(ctx, { reply: "Reply names a provider.", post: "The post names a provider." }),
          matches,
        )];
    },
  },
  {
    id: "H2.staff",
    packId: "hipaa",
    contentTypes: ["reply", "post"],
    description: "Reply contains a name from the workspace's staff list (playbook H2).",
    severity: "block",
    status: "active",
    check(ctx) {
      const matches: TextMatch[] = [];
      for (const name of ctx.workspace.staffNames) {
        if (name.trim().length < 2) continue;
        matches.push(...findMatches(ctx.reply, compileLiteral(name)));
      }
      if (matches.length === 0) return [];
      return [
        violation(
          "H2.staff",
          "block",
          say(ctx, { reply: "Reply names a staff member.", post: "The post names a staff member." }),
          sortedByStart(matches),
        ),
      ];
    },
  },
  {
    id: "H2.clinical",
    packId: "hipaa",
    description:
      "Reply contains a condition, treatment, accident, attorney, insurance or billing term from the curated lexicon (playbook H2/H3, conservative reading).",
    severity: "block",
    status: "active",
    check(ctx) {
      const matches = findMatches(scrubbed(ctx), LEXICON_RE);
      if (matches.length === 0) return [];
      return [
        violation(
          "H2.clinical",
          "block",
          "Reply mentions a condition, treatment, accident, attorney, insurance or billing term.",
          matches,
        ),
      ];
    },
  },
  {
    id: "H2.date",
    packId: "hipaa",
    description: "Reply contains a date or weekday (playbook H2).",
    severity: "block",
    status: "active",
    check(ctx) {
      const text = scrubbed(ctx);
      const matches = sortedByStart([
        ...findMatches(text, DATE_WORD_RE),
        ...DATE_NUMERIC_RES.flatMap((re) => findMatches(text, re)),
      ]);
      if (matches.length === 0) return [];
      return [violation("H2.date", "block", "Reply contains a date or weekday.", matches)];
    },
  },
  {
    id: "H2.echo",
    packId: "hipaa",
    description:
      "Reply repeats a run of 2+ words from the review text that contains a lexicon term (playbook H2 'never repeat ... even if the reviewer wrote them').",
    severity: "block",
    status: "active",
    check(ctx) {
      if (!ctx.review.text) return [];
      const matches = echoMatches(scrubbed(ctx), ctx.review.text);
      if (matches.length === 0) return [];
      return [
        violation("H2.echo", "block", "Reply repeats clinical wording from the review.", matches),
      ];
    },
  },
  {
    id: "H4.privacy-line",
    packId: "hipaa",
    description: `1-3 star replies must contain the fixed privacy line: "${PRIVACY_LINE}" (punctuation and apostrophe style may differ; playbook H4).`,
    severity: "block",
    status: "active",
    check(ctx) {
      const r = ctx.review.rating;
      if (r === null || r > 3) return [];
      if (normalise(ctx.reply).includes(normalise(PRIVACY_LINE))) return [];
      return [
        violation(
          "H4.privacy-line",
          "block",
          `1-3 star replies must include the privacy line: "${PRIVACY_LINE}"`,
        ),
      ];
    },
  },
  {
    id: "H4.phone",
    packId: "hipaa",
    description:
      "1-3 star replies must include the location's phone number when one is set (playbook H4).",
    severity: "block",
    status: "active",
    check(ctx) {
      const r = ctx.review.rating;
      const phone = ctx.location.phone;
      if (r === null || r > 3 || !phone || digitsOf(phone).length < 7) return [];
      if (containsPhone(ctx.reply, phone)) return [];
      return [
        violation("H4.phone", "block", `1-3 star replies must include the phone number ${phone}.`),
      ];
    },
  },
  {
    id: "H4.rebuttal",
    packId: "hipaa",
    description:
      "No rebuttal, accusation or denial in replies to 1-3 star reviews (playbook H4; FTC Consumer Review Rule).",
    severity: "block",
    status: "active",
    check(ctx) {
      const r = ctx.review.rating;
      if (r === null || r > 3) return [];
      const matches = findMatches(ctx.reply, REBUTTAL_RE);
      if (matches.length === 0) return [];
      return [
        violation("H4.rebuttal", "block", "Reply argues with or accuses the reviewer.", matches),
      ];
    },
  },
  {
    id: "H.skip-positive",
    packId: "hipaa",
    description:
      "Healthcare profile: replies to 4-5 star reviews are off while workspace.skipPositiveReviews is true.",
    severity: "block",
    status: "active",
    check(ctx) {
      const r = ctx.review.rating;
      if (!ctx.workspace.skipPositiveReviews || r === null || r < 4) return [];
      return [
        violation(
          "H.skip-positive",
          "block",
          "Healthcare profile: replies to positive reviews are off",
        ),
      ];
    },
  },
];
