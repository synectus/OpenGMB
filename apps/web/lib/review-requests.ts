// Pure logic for the Requests tab. No React, no core runtime imports.

export type Source = "link" | "qr" | "sms" | "email";

export const trackedUrl = (origin: string, slug: string, source: Source) =>
  `${origin.replace(/\/+$/, "")}/go/${slug}${source === "link" ? "" : `?s=${source}`}`;

export const embedSnippet = (origin: string, slug: string, layout?: string) =>
  `<script src="${origin.replace(/\/+$/, "")}/widget.js" data-location="${slug}"${layout ? ` data-layout="${layout}"` : ""} async></script>`;

export const SMS_TEMPLATE =
  "Thanks for choosing {location_name}. If you have a minute, tell us how we did on Google: {review_link} Reply STOP to opt out.";
export const EMAIL_TEMPLATE =
  "Subject: How did we do at {location_name}?\n\nThank you for choosing {location_name}.\n\nIf you have a minute, we would be grateful if you told us how we did on Google: {review_link}\n\nThank you.";

const KNOWN = ["location_name", "review_link"];

/** Replaces only {location_name} and {review_link}. Anything else is sent as written (the UI warns). */
export function renderMessage(template: string, v: { location_name: string; review_link: string }): string {
  return template.replaceAll("{location_name}", v.location_name).replaceAll("{review_link}", v.review_link);
}

export function unknownVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!))].filter((n) => !KNOWN.includes(n));
}

/** 160 characters per text, 153 once it splits; 70 and 67 when any character is outside basic ASCII. */
export function smsLength(text: string): { length: number; segments: number; limit: number } {
  const unicode = /\P{ASCII}/u.test(text);
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  const length = [...text].length;
  return { length, segments: length <= single ? 1 : Math.ceil(length / multi), limit: single };
}
