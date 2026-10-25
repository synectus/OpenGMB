import type { PostFields } from "./types";

/**
 * Canonical string for everything a post would send. Fixed key order, nulls explicit, so the same
 * content always gives the same string and any changed field (CTA url, offer terms, media url...)
 * gives a different one.
 */
export function postSubject(summary: string, post: PostFields): string {
  return JSON.stringify({
    summary,
    topicType: post.topicType,
    alertType: post.alertType ?? null,
    cta: post.cta ? { actionType: post.cta.actionType, url: post.cta.url ?? null } : null,
    event: post.event
      ? {
          title: post.event.title ?? null,
          startDate: post.event.startDate ?? null,
          startTime: post.event.startTime ?? null,
          endDate: post.event.endDate ?? null,
          endTime: post.event.endTime ?? null,
        }
      : null,
    offer: post.offer
      ? {
          couponCode: post.offer.couponCode ?? null,
          redeemOnlineUrl: post.offer.redeemOnlineUrl ?? null,
          termsConditions: post.offer.termsConditions ?? null,
        }
      : null,
    media: post.media.map((m) => m.sourceUrl),
  });
}
