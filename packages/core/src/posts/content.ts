import { z } from "zod";
import { POST_LIMITS } from "../config/post-limits";
import type { GoogleLocalPost } from "../google/client";
import type { GuardrailResult, PostFields } from "../guardrails";
import type { posts } from "@opengmb/db";
import { sha256 } from "../reviews/reply-state";

export type PostRow = typeof posts.$inferSelect;

const ctaTypes = POST_LIMITS.ctaActionTypes;

/**
 * Composer input shapes. Types and sizes are enforced here; CONTENT rules (phone numbers, the
 * 1,500-character cap, image count, CTA URL rules, event requirements, alert restrictions) are
 * guardrails (packs/post.ts), so `posts.check` can report them and a draft can exist while invalid.
 */
export const ctaInput = z.object({
  actionType: z.enum(ctaTypes),
  url: z.string().max(2000).optional(),
});
export const eventInput = z.object({
  title: z.string().max(300),
  /** YYYY-MM-DD */
  startDate: z.string().max(10),
  /** HH:MM (24h); omitted = 00:00 */
  startTime: z.string().max(5).optional(),
  endDate: z.string().max(10),
  /** HH:MM (24h); omitted = 23:59 */
  endTime: z.string().max(5).optional(),
});
export const offerInput = z.object({
  couponCode: z.string().max(100).optional(),
  redeemOnlineUrl: z.string().max(2000).optional(),
  termsConditions: z.string().max(5000).optional(),
});
export const mediaInput = z.object({ sourceUrl: z.string().max(2000) });

export const contentShape = {
  topicType: z.enum(["STANDARD", "EVENT", "OFFER", "ALERT"]),
  alertType: z.enum(["COVID_19"]).nullish(),
  summary: z.string().max(20_000).optional(),
  cta: ctaInput.nullish(),
  event: eventInput.nullish(),
  offer: offerInput.nullish(),
  media: z.array(mediaInput).max(10).optional(),
};

/**
 * What an edit of a published post may change: the fields Google's localPosts.patch takes in
 * `updateMask`. The topic type and the language never change (a different type is a different post).
 */
export const EDIT_FIELDS = ["summary", "callToAction", "event", "offer", "media"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export const editShape = {
  summary: contentShape.summary,
  cta: contentShape.cta,
  event: contentShape.event,
  offer: contentShape.offer,
  media: contentShape.media,
};

export type PostContent = {
  topicType: PostFields["topicType"];
  alertType: string | null;
  summary: string;
  cta: PostFields["cta"];
  event: PostFields["event"];
  offer: PostFields["offer"];
  media: { sourceUrl: string }[];
};

export function contentFromRow(r: PostRow): PostContent {
  return {
    topicType: r.topicType,
    alertType: r.alertType,
    summary: r.summary,
    cta: (r.cta as PostContent["cta"]) ?? null,
    event: (r.event as PostContent["event"]) ?? null,
    offer: (r.offer as PostContent["offer"]) ?? null,
    media: (r.media as PostContent["media"]) ?? [],
  };
}

export function fieldsOf(c: PostContent): PostFields {
  return {
    topicType: c.topicType,
    alertType: c.alertType,
    cta: c.cta,
    event: c.event,
    offer: c.offer,
    media: c.media,
  };
}

type Nullable<T> = { [K in keyof T]?: T[K] | null | undefined };

/** Apply a partial input over existing content: a provided key (including null) replaces it. */
export function mergeContent(
  base: PostContent,
  patch: Nullable<z.input<z.ZodObject<typeof contentShape>>>,
): PostContent {
  const has = <K extends keyof typeof patch>(k: K) => patch[k] !== undefined;
  return {
    topicType: patch.topicType ?? base.topicType,
    alertType: has("alertType") ? (patch.alertType ?? null) : base.alertType,
    summary: has("summary") ? (patch.summary ?? "") : base.summary,
    cta: has("cta") ? ((patch.cta as PostContent["cta"]) ?? null) : base.cta,
    event: has("event") ? ((patch.event as PostContent["event"]) ?? null) : base.event,
    offer: has("offer") ? ((patch.offer as PostContent["offer"]) ?? null) : base.offer,
    media: has("media") ? (patch.media ?? []) : base.media,
  };
}

const ymd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
};
const hm = (s: string | null | undefined, fallback: string) => {
  const [h, m] = (s ?? fallback).split(":").map(Number);
  return { hours: h!, minutes: m! };
};

/** The LocalPost body for Google. Only call with content that passed the guardrails. */
export function toGoogleLocalPost(c: PostContent, languageCode?: string): GoogleLocalPost {
  return {
    ...(languageCode ? { languageCode } : {}),
    topicType: c.topicType,
    ...(c.summary.trim() ? { summary: c.summary } : {}),
    ...(c.cta && c.topicType !== "OFFER"
      ? {
          callToAction: {
            actionType: c.cta.actionType as NonNullable<
              GoogleLocalPost["callToAction"]
            >["actionType"],
            ...(c.cta.actionType !== "CALL" && c.cta.url ? { url: c.cta.url } : {}),
          },
        }
      : {}),
    ...(c.event && (c.topicType === "EVENT" || c.topicType === "OFFER")
      ? {
          event: {
            title: c.event.title ?? "",
            schedule: {
              startDate: ymd(c.event.startDate ?? ""),
              startTime: hm(c.event.startTime, "00:00"),
              endDate: ymd(c.event.endDate ?? ""),
              endTime: hm(c.event.endTime, "23:59"),
            },
          },
        }
      : {}),
    ...(c.offer && c.topicType === "OFFER"
      ? {
          offer: {
            ...(c.offer.couponCode ? { couponCode: c.offer.couponCode } : {}),
            ...(c.offer.redeemOnlineUrl ? { redeemOnlineUrl: c.offer.redeemOnlineUrl } : {}),
            ...(c.offer.termsConditions ? { termsConditions: c.offer.termsConditions } : {}),
          },
        }
      : {}),
    ...(c.alertType && c.topicType === "ALERT" ? { alertType: c.alertType as "COVID_19" } : {}),
    ...(c.media.length > 0
      ? { media: c.media.map((m) => ({ mediaFormat: "PHOTO" as const, sourceUrl: m.sourceUrl })) }
      : {}),
  };
}

/**
 * What an audit row may say about a post: ids, statuses, lengths, the summary's sha256, flags and
 * rule ids/severities. NEVER the summary, event title, offer terms or code, CTA or media URLs, or
 * guardrail messages and matched text.
 */
export function postAuditFields(
  post: Pick<PostRow, "id" | "workspaceId" | "topicType" | "summary" | "occurrence" | "media"> &
    Partial<Pick<PostRow, "cta" | "event" | "offer">>,
  guardrail?: GuardrailResult | null,
): Record<string, unknown> {
  return {
    postId: post.id,
    workspaceId: post.workspaceId,
    topicType: post.topicType,
    occurrence: post.occurrence,
    summaryLength: Array.from(post.summary).length,
    summarySha256: sha256(post.summary),
    hasCta: Boolean(post.cta),
    hasEvent: Boolean(post.event),
    hasOffer: Boolean(post.offer),
    mediaCount: Array.isArray(post.media) ? post.media.length : 0,
    ...(guardrail
      ? {
          guardrail: {
            ok: guardrail.ok,
            violations: guardrail.violations.map((v) => ({
              ruleId: v.ruleId,
              severity: v.severity,
            })),
          },
        }
      : {}),
  };
}

/**
 * The Google fields (updateMask names) whose value differs between two versions of a post's
 * content, compared as Google would see them (toGoogleLocalPost), so a CTA hidden on an offer or a
 * whitespace-only summary does not count. A field that was set and is now empty IS a change: it
 * goes in the mask and is absent from the body, which is how Google clears it.
 */
export function changedEditFields(current: PostContent, next: PostContent): EditField[] {
  const a = toGoogleLocalPost(current);
  const b = toGoogleLocalPost(next);
  return EDIT_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}
