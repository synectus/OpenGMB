import { DUPLICATE_WINDOW_REPLIES, REPLY_MAX_BYTES } from "../../config/google-limits";
import {
  BANNED_STARTS,
  BANNED_VERBS,
  EM_DASH,
  SCANNED_PHRASES,
} from "../../config/writing-style";
import { byteLength, compileLexicon, findMatches, firstSentence, normalise } from "../text";
import type { GuardrailContext, Rule, Violation } from "../types";
import { say } from "./wording";

type V = Omit<Violation, "status">;

/** Playbook U4. Source: the internal GBP reply playbook (v1, 2026-09-27). */
const BANNED_BOILERPLATE = [
  "thrilled to hear",
  "your kind words",
  "thank you for your kind",
  "we appreciate your feedback",
  "means the world",
  "glad you had a great experience",
  "we look forward to serving you",
  "valued customer",
  "it was a pleasure",
];
const BOILERPLATE_RE = compileLexicon(BANNED_BOILERPLATE);

/**
 * U8.style: the Synectus writing style (config/writing-style.ts). Hyphens in an entry match a space
 * too ("cutting-edge" == "cutting edge"). A verb also matches its inflections (delve, delves, delved, delving).
 */
function verbSource(v: string): string {
  const z = v.replace(/z/g, "[sz]");
  if (v.endsWith("e")) return `${z.slice(0, -1)}(?:e|es|ed|ing)`;
  if (v.endsWith("y")) return `${z.slice(0, -1)}(?:y|ies|ied|ying)`;
  return `${z}(?:s|es|ed|ing)?`;
}
const STYLE_RE = compileLexicon([
  ...SCANNED_PHRASES.map((p) => p.replace(/-/g, " ")),
  ...BANNED_VERBS.map(verbSource),
]);
const STYLE_START_RE = compileLexicon(BANNED_STARTS.map((p) => p.replace(/-/g, " ")));

/** Playbook U7: offers and promotions. */
const OFFER_RE = compileLexicon([
  "discount(s|ed)?",
  "coupons?",
  "promo(tions?|tional| codes?)?",
  "vouchers?",
  "\\d+\\s?%\\s?off",
  "percent off",
  "\\$\\d[\\d,]* off",
  "free (consultations?|consults?|estimates?|exams?|evaluations?|assessments?|quotes?|trials?|checkups?|screenings?|x(-| )?rays?)",
  "special offers?",
  "limited(-| )time",
  "buy one get one",
  "bogo",
  "new patient special",
]);

const URL_RE =
  /(?<![@\w.-])(?:https?:\/\/[^\s<>"]*[^\s<>".,;:!?)]|www\.[^\s<>"]*[^\s<>".,;:!?)]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|edu|gov|io|co|us|info|biz|app|health|care|law|me|ly|xyz)(?:\/[^\s<>"]*[^\s<>".,;:!?)])?)(?![\w@-])/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const HASHTAG_RE = /(?<![\p{L}\p{N}&])#\p{L}[\p{L}\p{N}_]*/gu;

function matchRule(
  base: Pick<Rule, "id" | "description" | "severity" | "status" | "contentTypes">,
  re: RegExp,
  message: (n: number, ctx: GuardrailContext) => string,
): Rule {
  return {
    ...base,
    packId: "universal",
    check(ctx) {
      const matches = findMatches(ctx.reply, re);
      if (matches.length === 0) return [];
      return [
        {
          ruleId: base.id,
          packId: "universal",
          severity: base.severity,
          message: message(matches.length, ctx),
          matches,
        },
      ];
    },
  };
}

/** Recent replies inside the R6 window, newest first. */
function windowOf(ctx: GuardrailContext): string[] {
  return ctx.recentReplies.slice(0, DUPLICATE_WINDOW_REPLIES);
}

/** Index (newest = 0) of the first recent reply identical to `reply` after normalisation. */
function duplicateIndex(ctx: GuardrailContext): number {
  const mine = normalise(ctx.reply);
  if (mine === "") return -1;
  return windowOf(ctx).findIndex((r) => normalise(r) === mine);
}

export const universalRules: Rule[] = [
  {
    id: "U.empty",
    packId: "universal",
    description: "Reply is empty (or only punctuation/whitespace).",
    severity: "block",
    status: "active",
    check(ctx): V[] {
      if (normalise(ctx.reply) !== "") return [];
      return [
        {
          ruleId: "U.empty",
          packId: "universal",
          severity: "block",
          message: "Reply is empty.",
        },
      ];
    },
  },
  {
    id: "U.length",
    packId: "universal",
    description: `Reply is longer than Google's ${REPLY_MAX_BYTES}-byte limit (UTF-8).`,
    severity: "block",
    status: "active",
    check(ctx): V[] {
      const bytes = byteLength(ctx.reply);
      if (bytes <= REPLY_MAX_BYTES) return [];
      return [
        {
          ruleId: "U.length",
          packId: "universal",
          severity: "block",
          message: `Reply is ${bytes} bytes; Google accepts at most ${REPLY_MAX_BYTES}.`,
        },
      ];
    },
  },
  matchRule(
    {
      id: "U4",
      description: "Banned boilerplate phrase (playbook U4). Reads as templated.",
      severity: "warn",
      status: "active",
    },
    BOILERPLATE_RE,
    (n) => `Contains ${n} banned boilerplate phrase(s); reword in your own voice.`,
  ),
  {
    id: "U8.style",
    packId: "universal",
    // Replies, posts and profile text (a description is read by customers like a reply is).
    contentTypes: ["reply", "post", "profile"],
    description:
      "Wording the Synectus writing style bans (config/writing-style.ts): an em dash, a banned word or phrase, or a sycophantic opener. Warns so a person sees it in approval.",
    severity: "warn",
    status: "active",
    check(ctx): V[] {
      const lead = ctx.reply.length - ctx.reply.trimStart().length;
      const matches = [
        ...findMatches(ctx.reply, STYLE_RE),
        ...findMatches(ctx.reply, STYLE_START_RE).filter((m) => m.start === lead),
        ...findMatches(ctx.reply, new RegExp(EM_DASH, "g")),
      ].sort((a, b) => a.start - b.start);
      if (matches.length === 0) return [];
      return [
        {
          ruleId: "U8.style",
          packId: "universal",
          severity: "warn",
          message: say(ctx, {
            reply: `Contains ${matches.length} wording the writing style bans (an em dash, stock or AI-sounding words); reword in plain words.`,
            post: `The post contains ${matches.length} wording the writing style bans (an em dash, stock or AI-sounding words); reword in plain words.`,
          }),
          matches,
        },
      ];
    },
  },
  matchRule(
    {
      id: "U7.url",
      contentTypes: ["reply", "post", "profile"],
      description: "URLs are not allowed in replies (playbook U7).",
      severity: "block",
      status: "active",
    },
    URL_RE,
    (_n, ctx) =>
      say(ctx, {
        reply: "Reply contains a URL or web address.",
        post: "Links are not allowed in the text. Use the button URL.",
        profile: "The description contains a URL or web address.",
      }),
  ),
  matchRule(
    {
      id: "U7.email",
      contentTypes: ["reply", "post", "profile"],
      description: "Email addresses are not allowed in replies (playbook U7).",
      severity: "block",
      status: "active",
    },
    EMAIL_RE,
    (_n, ctx) =>
      say(ctx, {
        reply: "Reply contains an email address.",
        post: "The post contains an email address.",
        profile: "The description contains an email address.",
      }),
  ),
  matchRule(
    {
      id: "U7.hashtag",
      contentTypes: ["reply", "post", "profile"],
      description: "Hashtags are not allowed in replies (playbook U7).",
      severity: "block",
      status: "active",
    },
    HASHTAG_RE,
    (_n, ctx) =>
      say(ctx, {
        reply: "Reply contains a hashtag.",
        post: "The post contains a hashtag.",
        profile: "The description contains a hashtag.",
      }),
  ),
  matchRule(
    {
      id: "U7.offer",
      description: "Offers, discounts and promotions are not allowed in replies (playbook U7).",
      severity: "block",
      status: "active",
    },
    OFFER_RE,
    () => "Reply contains offer or promotion wording.",
  ),
  {
    id: "R6.duplicate",
    packId: "universal",
    description: `Reply is identical (after normalisation) to one of the location's last ${DUPLICATE_WINDOW_REPLIES} published replies (playbook U3/R6).`,
    severity: "block",
    status: "active",
    check(ctx): V[] {
      const i = duplicateIndex(ctx);
      if (i < 0) return [];
      return [
        {
          ruleId: "R6.duplicate",
          packId: "universal",
          severity: "block",
          message: `Identical to published reply #${i + 1} for this location (newest = #1).`,
        },
      ];
    },
  },
  {
    id: "R6.opening",
    packId: "universal",
    description: `Opening sentence matches the opening sentence of one of the location's last ${DUPLICATE_WINDOW_REPLIES} published replies (playbook U3/R6).`,
    severity: "warn",
    status: "active",
    check(ctx): V[] {
      if (duplicateIndex(ctx) >= 0) return []; // R6.duplicate already covers it
      const mine = normalise(firstSentence(ctx.reply));
      if (mine === "") return [];
      const i = windowOf(ctx).findIndex((r) => normalise(firstSentence(r)) === mine);
      if (i < 0) return [];
      return [
        {
          ruleId: "R6.opening",
          packId: "universal",
          severity: "warn",
          message: `Opens with the same sentence as published reply #${i + 1} for this location; vary the opening.`,
        },
      ];
    },
  },
];
