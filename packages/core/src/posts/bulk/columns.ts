/**
 * The CSV columns of a bulk post import: one place for the parser, the downloadable template and
 * the table on the Import page. `names` are the accepted header spellings (compared after dropping
 * case, spaces, "_" and "-"); the first is the canonical one.
 */
export const BULK_COLUMNS = [
  { key: "location", names: ["location", "locationname", "locationid", "store"], required: true, help: "Location name (as shown in Synectus) or its id. One location per row." },
  { key: "type", names: ["type", "topictype", "posttype"], required: false, help: "STANDARD (default), EVENT or OFFER." },
  { key: "summary", names: ["summary", "text", "post", "body", "message"], required: true, help: "The post text. Variables: {name} {city} {phone} {address} {website}." },
  { key: "ctaType", names: ["cta_type", "cta", "button"], required: false, help: "Book, Order, Shop, Learn more, Sign up or Call." },
  { key: "ctaUrl", names: ["cta_url", "url", "link", "buttonurl"], required: false, help: "Button link (https). Not used with CALL." },
  { key: "scheduled", names: ["scheduled", "schedule", "scheduledfor", "sendat"], required: false, help: "Send time to remember on the draft: YYYY-MM-DD HH:MM in the client's time zone." },
  { key: "imageUrl", names: ["image_url", "image", "photo"], required: false, help: "One image link (https)." },
  { key: "eventTitle", names: ["event_title"], required: false, help: "EVENT and OFFER posts: the title." },
  { key: "eventStartDate", names: ["event_start_date", "eventstart"], required: false, help: "EVENT and OFFER posts: YYYY-MM-DD." },
  { key: "eventEndDate", names: ["event_end_date", "eventend"], required: false, help: "EVENT and OFFER posts: YYYY-MM-DD." },
  { key: "eventStartTime", names: ["event_start_time"], required: false, help: "Optional HH:MM (24 hour)." },
  { key: "eventEndTime", names: ["event_end_time"], required: false, help: "Optional HH:MM (24 hour)." },
  { key: "couponCode", names: ["coupon_code", "coupon"], required: false, help: "OFFER posts: coupon code." },
  { key: "redeemUrl", names: ["redeem_url", "redeemonlineurl"], required: false, help: "OFFER posts: link to redeem online." },
  { key: "terms", names: ["terms", "termsconditions"], required: false, help: "OFFER posts: terms and conditions." },
] as const;
export type BulkColumnKey = (typeof BULK_COLUMNS)[number]["key"];

export const columnId = (header: string) => header.toLowerCase().replace(/[\s_-]+/g, "");

/** The file people download, with two example rows dated a week and a month after `now`. */
export function bulkTemplateCsv(now: Date): string {
  const day = (plusDays: number) => new Date(now.getTime() + plusDays * 86_400_000).toISOString().slice(0, 10);
  return [
    BULK_COLUMNS.map((c) => c.names[0]).join(","),
    `Acme Dental Austin,STANDARD,"Book a visit at {name} in {city}, we would love to see you.",BOOK,https://example.com/book,${day(7)} 09:00,,,,,,,,,`,
    `Acme Dental Dallas,OFFER,"Winter check-up offer at {name}.",LEARN_MORE,https://example.com/offer,,,Winter offer,${day(7)},${day(30)},,,WINTER10,,"Valid for new patients."`,
  ].join("\n");
}
