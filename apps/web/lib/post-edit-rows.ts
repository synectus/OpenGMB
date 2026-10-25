// Labels and the "now / proposed" rows for a post edit. Used by the approval screens.
const CTA: Record<string, string> = {
  BOOK: "Book",
  ORDER: "Order online",
  SHOP: "Buy",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  CALL: "Call now",
};
export const ctaLabel = (actionType: string) => CTA[actionType] ?? actionType;

type EditPost = {
  summary: string;
  cta: { actionType: string; url?: string | null } | null;
  event: { title?: string | null; startDate?: string | null; endDate?: string | null } | null;
  offer: { couponCode?: string | null; termsConditions?: string | null } | null;
  media: { sourceUrl: string }[];
};
const EDIT_FIELD: [string, string, (p: EditPost) => string][] = [
  ["summary", "Text", (p) => p.summary || "(no text)"],
  [
    "callToAction",
    "Button",
    (p) => (p.cta ? `${ctaLabel(p.cta.actionType)}${p.cta.url ? ` (${p.cta.url})` : ""}` : "No button"),
  ],
  [
    "event",
    "Event",
    (p) =>
      p.event
        ? [p.event.title, p.event.startDate && `from ${p.event.startDate}`, p.event.endDate && `to ${p.event.endDate}`]
            .filter(Boolean)
            .join(" ")
        : "No event",
  ],
  [
    "offer",
    "Offer",
    (p) =>
      p.offer
        ? [p.offer.couponCode && `Code ${p.offer.couponCode}`, p.offer.termsConditions && `Terms: ${p.offer.termsConditions}`]
            .filter(Boolean)
            .join(" · ") || "Offer"
        : "No offer",
  ],
  ["media", "Image", (p) => (p.media[0] ? p.media[0].sourceUrl : "No image")],
];

/** What a post edit changes: one row per changed field, "on Google now" beside "proposed". `changed` are Google field names. */
export function editChangeRows(
  now: EditPost,
  next: EditPost,
  changed: string[],
): { field: string; label: string; now: string; next: string }[] {
  return EDIT_FIELD.filter(([field]) => changed.includes(field)).map(([field, label, show]) => ({
    field,
    label,
    now: show(now),
    next: show(next),
  }));
}
