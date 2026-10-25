import { POST_LIMITS, POST_MAX_CHARS, POST_MAX_IMAGES } from "../../config/post-limits";
import { findMatches, type TextMatch } from "../text";
import type { GuardrailContext, PostFields, Rule, Severity, Violation } from "../types";

type V = Omit<Violation, "status">;

/** Phone numbers in post text (Synectus rule; Google may reject them). The CALL button is the route. */
const PHONE_RES = [
  // 10-digit North American: (713) 555-0142, 713.555.0142, +1 713 555 0142, 7135550142
  /(?<![\d$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/gu,
  // 7-digit local with a separator: 555-0142
  /(?<![\d$.,-])\d{3}[\s.-]\d{4}(?![\d-])/gu,
  // toll-free, including vanity: 1-800-FLOWERS
  /(?<![\p{L}\d])1[\s.-]?8(?:00|33|44|55|66|77|88)[\s.-][A-Za-z0-9]{3,}(?:[\s.-][A-Za-z0-9]{1,4})?/gu,
  // international: +44 20 7946 0958
  /(?<![\d\w])\+\d{1,3}[\s.-]?\d[\d\s().-]{6,}\d/gu,
];

function phoneMatches(text: string): TextMatch[] {
  const all = PHONE_RES.flatMap((re) => findMatches(text, re)).sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const out: TextMatch[] = [];
  for (const m of all) if (!out.length || m.start >= out[out.length - 1]!.end) out.push(m);
  return out;
}

export function isHttpUrl(s: string | null | undefined): boolean {
  if (!s || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validDate(s: string | null | undefined): boolean {
  const m = s ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return (
    d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
  );
}

/** Sortable key for date + optional time (start defaults 00:00, end defaults 23:59). */
function stamp(date: string, time: string | null | undefined, fallback: string): string {
  return `${date}T${time ?? fallback}`;
}

function post(ctx: GuardrailContext): PostFields | null {
  return ctx.post ?? null;
}

function rule(
  id: string,
  severity: Severity,
  description: string,
  check: (ctx: GuardrailContext, p: PostFields) => V[],
): Rule {
  return {
    id,
    packId: "post",
    description,
    severity,
    status: "active",
    contentTypes: ["post"],
    check(ctx) {
      const p = post(ctx);
      return p ? check(ctx, p) : [];
    },
  };
}

const v = (ruleId: string, severity: Severity, message: string, matches?: TextMatch[]): V => ({
  ruleId,
  packId: "post",
  severity,
  message,
  ...(matches && matches.length ? { matches } : {}),
});

const CTA_TYPES: readonly string[] = POST_LIMITS.ctaActionTypes;

export const postRules: Rule[] = [
  rule(
    "P.summary",
    "block",
    "STANDARD and ALERT posts need a summary (Google Help: updates need a description). EVENT and OFFER posts may omit it.",
    (ctx, p) =>
      (p.topicType === "STANDARD" || p.topicType === "ALERT") && ctx.reply.trim() === ""
        ? [v("P.summary", "block", `A ${p.topicType} post needs a summary.`)]
        : [],
  ),
  rule(
    "P.phone",
    "block",
    "No phone numbers in post text (summary, event title, offer terms). Use the CALL button, which uses the location's phone.",
    (ctx, p) => {
      const out: V[] = [];
      const inSummary = phoneMatches(ctx.reply);
      if (inSummary.length) {
        out.push(
          v(
            "P.phone",
            "block",
            "Summary contains a phone number; remove it and use the CALL button instead.",
            inSummary,
          ),
        );
      }
      for (const [field, text] of [
        ["event title", p.event?.title],
        ["offer terms", p.offer?.termsConditions],
        ["coupon code", p.offer?.couponCode],
      ] as const) {
        if (text && phoneMatches(text).length) {
          out.push(v("P.phone", "block", `The ${field} contains a phone number.`));
        }
      }
      return out;
    },
  ),
  rule(
    "P.length",
    "block",
    `Summary is longer than ${POST_MAX_CHARS} characters (Synectus rule; counted in Unicode code points).`,
    (ctx) => {
      const n = Array.from(ctx.reply).length;
      return n > POST_MAX_CHARS
        ? [v("P.length", "block", `Summary is ${n} characters; the limit is ${POST_MAX_CHARS}.`)]
        : [];
    },
  ),
  rule(
    "P.images",
    "block",
    `At most ${POST_MAX_IMAGES} image per post, and each image must be an http(s) URL.`,
    (_ctx, p) => {
      const out: V[] = [];
      if (p.media.length > POST_MAX_IMAGES) {
        out.push(
          v(
            "P.images",
            "block",
            `Post has ${p.media.length} images; the limit is ${POST_MAX_IMAGES}.`,
          ),
        );
      }
      if (p.media.some((m) => !isHttpUrl(m.sourceUrl))) {
        out.push(v("P.images", "block", "Image URL must be a valid http(s) URL."));
      }
      return out;
    },
  ),
  rule(
    "P.cta",
    "block",
    "Call to action: type must be BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP or CALL; every type except CALL needs an http(s) URL; CALL must have none (it uses the location's phone). Google ignores a CTA on OFFER posts (warning).",
    (_ctx, p) => {
      const c = p.cta;
      if (!c) return [];
      const out: V[] = [];
      if (!CTA_TYPES.includes(c.actionType)) {
        out.push(v("P.cta", "block", `Unknown call to action type "${c.actionType}".`));
        return out;
      }
      if (c.actionType === "CALL") {
        if (c.url) out.push(v("P.cta", "block", "A CALL button takes no URL; remove it."));
      } else if (!isHttpUrl(c.url)) {
        out.push(v("P.cta", "block", `A ${c.actionType} button needs a valid http(s) URL.`));
      }
      if (p.topicType === "OFFER") {
        out.push(
          v("P.cta", "warn", "Google ignores the call to action on OFFER posts; it will not show."),
        );
      }
      return out;
    },
  ),
  rule(
    "P.alert",
    "block",
    "ALERT posts need alertType COVID_19 (the only AlertType), support only summary and call to action, and Google has disabled creating new COVID_19 alerts (warning). alertType is only valid on ALERT posts.",
    (_ctx, p) => {
      const out: V[] = [];
      const allowed: readonly string[] = POST_LIMITS.alert.alertTypes;
      if (p.topicType !== "ALERT") {
        if (p.alertType) out.push(v("P.alert", "block", "alertType is only valid on ALERT posts."));
        return out;
      }
      if (!p.alertType || !allowed.includes(p.alertType)) {
        out.push(v("P.alert", "block", `An ALERT post needs alertType ${allowed.join(" or ")}.`));
      }
      if (p.event || p.offer || p.media.length > 0) {
        out.push(v("P.alert", "block", "ALERT posts support only a summary and a call to action."));
      }
      out.push(
        v(
          "P.alert",
          "warn",
          "Google has disabled creating new COVID_19 alerts; this post will probably be rejected.",
        ),
      );
      return out;
    },
  ),
  rule(
    "P.event",
    "block",
    "EVENT and OFFER posts need an event with a title and start and end dates (times optional: start 00:00, end 23:59); end must not precede start. event is invalid on other types; offer is only valid on OFFER and its redeem URL must be http(s).",
    (_ctx, p) => {
      const out: V[] = [];
      const needsEvent = (POST_LIMITS.eventRequiredFor as readonly string[]).includes(p.topicType);
      if (!needsEvent && p.event) {
        out.push(v("P.event", "block", `event is not valid on a ${p.topicType} post.`));
      }
      if (p.topicType !== "OFFER" && p.offer) {
        out.push(v("P.event", "block", "offer is only valid on an OFFER post."));
      }
      if (needsEvent) {
        const e = p.event;
        if (!e || !e.title?.trim()) {
          out.push(v("P.event", "block", `A ${p.topicType} post needs an event title.`));
        }
        if (!e || !validDate(e.startDate) || !validDate(e.endDate)) {
          out.push(
            v(
              "P.event",
              "block",
              `A ${p.topicType} post needs valid start and end dates (YYYY-MM-DD).`,
            ),
          );
        } else {
          const badTime = [e.startTime, e.endTime].some((t) => t && !TIME_RE.test(t));
          if (badTime) out.push(v("P.event", "block", "Event times must be HH:MM (24 hour)."));
          else if (
            stamp(e.endDate!, e.endTime, "23:59") < stamp(e.startDate!, e.startTime, "00:00")
          ) {
            out.push(v("P.event", "block", "Event end is before its start."));
          }
        }
      }
      if (p.offer?.redeemOnlineUrl && !isHttpUrl(p.offer.redeemOnlineUrl)) {
        out.push(v("P.event", "block", "Offer redeem URL must be a valid http(s) URL."));
      }
      return out;
    },
  ),
];
