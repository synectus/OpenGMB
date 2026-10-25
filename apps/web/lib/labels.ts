// Plain words for system values (U2). Every page that would otherwise print a Google id, an enum,
// a status code, a guardrail rule id or an epoch date goes through here. Nothing in this file
// returns the raw value; the worst case is the value spoken as words.

/** What to show for a timestamp that is missing or is the 1970 placeholder. */
export const UNKNOWN_DATE = "Unknown date";

/** `true` for null, empty, unparseable and the Unix epoch (a "missing" timestamp stored as 0). */
export function isMissingTimestamp(v: string | number | Date | null | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isNaN(t) || t <= 86_400_000; // 1970-01-02 and earlier cannot be a real Google timestamp
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** `internet_marketing_service` / `INTERNET-MARKETING` / `categories/gcid:web_designer` as "Internet marketing service". */
export function humanise(id: string): string {
  const core = id
    .trim()
    .replace(/^(categories|attributes)\//, "")
    .replace(/^[a-z_]+:/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return sentence(core);
}

/** A Google category id as its display name; `names` is the metadata already loaded (id to displayName). */
export function categoryLabel(id: string, names?: Record<string, string>): string {
  const known = names?.[id] ?? names?.[`categories/${id.replace(/^categories\//, "")}`];
  return known && known.trim() ? known : humanise(id) || "Unnamed category";
}

type AttributeMeta = { name: string; displayName?: string | null };
/** An attribute id (`attributes/has_onsite_parking`) as its display name, from loaded metadata when there. */
export function attributeLabel(id: string, metas?: readonly AttributeMeta[] | Record<string, string>): string {
  let known: string | null | undefined;
  if (Array.isArray(metas)) known = (metas as readonly AttributeMeta[]).find((m) => m.name === id)?.displayName;
  else if (metas) known = (metas as Record<string, string>)[id];
  return known && known.trim() ? known : humanise(id) || "Unnamed attribute";
}

const ENUM: Record<string, string> = {
  // photo categories
  COVER: "Cover photo",
  PROFILE: "Logo",
  LOGO: "Logo",
  EXTERIOR: "Exterior",
  INTERIOR: "Interior",
  PRODUCT: "Product",
  AT_WORK: "At work",
  FOOD_AND_DRINK: "Food and drink",
  MENU: "Menu",
  COMMON_AREA: "Common area",
  ROOMS: "Rooms",
  TEAMS: "Team",
  ADDITIONAL: "Additional",
  // Google post states
  LIVE: "Published",
  PROCESSING: "Processing",
  REJECTED: "Rejected by Google",
  // post types and buttons
  STANDARD: "Update",
  EVENT: "Event",
  OFFER: "Offer",
  ALERT: "Alert",
  COVID_19: "COVID-19 update",
  BOOK: "Book",
  ORDER: "Order online",
  SHOP: "Shop",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  CALL: "Call now",
  // verification
  PENDING: "Pending",
  COMPLETED: "Completed",
  FAILED: "Failed",
  PHONE_CALL: "Phone call",
  SMS: "Text message",
  EMAIL: "Email",
  ADDRESS: "Postcard",
  VETTED_PARTNER: "Verified partner",
  // location open state and misc
  OPEN: "Open",
  CLOSED_PERMANENTLY: "Permanently closed",
  CLOSED_TEMPORARILY: "Temporarily closed",
  CUSTOMER_LOCATION_ONLY: "Customers only",
  BUSINESS_LOCATION: "Business address",
  // week days
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};

/** The enum values this module names; the e2e guard looks for the ones with an underscore. */
export const KNOWN_ENUMS: readonly string[] = Object.keys(ENUM);

/** An UPPER_SNAKE Google enum (`AT_WORK`) in plain words ("At work"). */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return "Not set";
  return ENUM[value] ?? (humanise(value) || "Not set");
}

const STATUS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  pending: "Pending",
  pending_approval: "Waiting for approval",
  awaiting_approval: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  publishing: "Publishing",
  scheduled: "Scheduled",
  draft: "Draft",
  failed: "Failed",
  blocked: "Blocked",
  conflict: "Changed on Google",
  applied: "Applied",
  no_change: "No change",
  queued: "Queued",
  running: "Running",
  in_progress: "In progress",
  done: "Done",
  completed: "Completed",
  succeeded: "Succeeded",
  accepted: "Accepted",
  ready: "Ready",
  verified: "Verified",
  unverified: "Not verified",
  suspended: "Suspended",
  disabled: "Turned off",
  error: "Error",
  expired: "Expired",
  revoked: "Revoked",
  sent: "Sent",
  skipped: "Skipped",
};

/** A status value (`pending_approval`, `active`) as a short phrase. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return STATUS[status.toLowerCase()] ?? (humanise(status) || "Unknown");
}

/** A plain name for each guardrail rule, for places that only have the rule id (the message is better when there). */
const RULE: Record<string, string> = {
  "U.empty": "The reply is empty",
  "U.length": "The reply is too long for Google",
  U4: "Contains a stock phrase that reads as templated",
  "U7.url": "Contains a link",
  "U7.email": "Contains an email address",
  "U7.hashtag": "Contains a hashtag",
  "U7.offer": "Mentions an offer or discount",
  "U8.style": "Uses wording that reads as AI-written or stock",
  "R6.duplicate": "Same as a recent reply",
  "R6.opening": "Starts the same way as a recent reply",
  H1: "Implies a care relationship",
  "H2.reviewer": "Uses the reviewer's name",
  "H2.provider": "Names a provider",
  "H2.staff": "Names a staff member",
  "H2.clinical": "Mentions a condition, treatment or billing detail",
  "H2.date": "Mentions a date or weekday",
  "H2.echo": "Repeats wording from the review",
  "H4.privacy-line": "Missing the privacy sentence",
  "H4.phone": "Missing the office phone number",
  "H4.rebuttal": "Argues with the reviewer",
  "H.skip-positive": "Replies to positive reviews are turned off",
  "LE1.relationship": "Implies a client relationship",
  "LE2.case-facts": "Discusses case details",
  "LE3.guarantee": "Promises or guarantees a result",
  "LE4.testimonial": "Asks for a testimonial or endorsement",
  "P.summary": "The post needs text",
  "P.phone": "A phone number in the post text",
  "P.length": "The post text is too long",
  "P.images": "Too many images, or an image that is not a web link",
  "P.cta": "The button is not valid",
  "P.alert": "The alert post is not valid",
  "P.event": "The event or offer needs a title and dates",
  "PR.description-length": "The description is too long",
  "PR.hours-valid": "The opening hours are not valid",
  "PR.special-hours-valid": "The holiday hours are not valid",
  "PR.phone-format": "The phone numbers are not valid",
  "PR.address-reverification": "Changing the address can send the location back to verification",
  "PR.address-valid": "The address is not valid",
  "PR.store-code-length": "The store code is too long",
};
export const GUARDRAIL_RULE_IDS: readonly string[] = Object.keys(RULE);

/** The human line for a guardrail finding: its own message when it has one, else the rule's plain name. */
export function guardrailLabel(ruleId: string | null | undefined, message?: string | null): string {
  if (message && message.trim()) return message;
  return (ruleId && RULE[ruleId]) || "A content rule blocked this";
}

const FIELD: Record<string, string> = {
  title: "Name",
  description: "Description",
  categories: "Categories",
  regularHours: "Opening hours",
  specialHours: "Holiday hours",
  serviceItems: "Services",
  serviceArea: "Service area",
  websiteUri: "Website",
  openingDate: "Opening date",
  phoneNumbers: "Phone numbers",
  storeCode: "Store code",
  storefrontAddress: "Address",
};

/** One profile field path (`regularHours`, `attributes/has_wifi`) as a label. */
export function profileFieldLabel(path: string, attributeMetas?: readonly AttributeMeta[] | Record<string, string>): string {
  if (path.startsWith("attributes/")) return `Attribute: ${attributeLabel(path, attributeMetas)}`;
  return FIELD[path] ?? (humanise(path) || "Field");
}

/** "Opening hours, Website". */
export const profileFieldsLabel = (paths: readonly string[]): string => paths.map((p) => profileFieldLabel(p)).join(", ");

const ENUM_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ID_SHAPE = /^(?:categories\/)?(?:gcid|job_type_id):[A-Za-z0-9_]+$/;

/**
 * A stored profile value with its system words replaced, ready to be printed as text or JSON:
 * category ids and service type ids become words, `attributes/x` keys become attribute names,
 * and UPPER_SNAKE enum strings become plain words. Does not change the input.
 */
export function plainValue(v: unknown, names?: Record<string, string>): unknown {
  if (typeof v === "string") {
    if (ID_SHAPE.test(v)) return categoryLabel(v, names);
    if (ENUM_SHAPE.test(v)) return enumLabel(v);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => plainValue(x, names));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k.startsWith("attributes/") ? attributeLabel(k) : k,
        plainValue(x, names),
      ]),
    );
  }
  return v;
}

/** Free text from the server with any `categories/gcid:x`, `gcid:x` or `attributes/x` inside it turned into words. */
export function plainText(text: string, names?: Record<string, string>): string {
  return text
    .replace(/(?:categories\/)?gcid:[A-Za-z0-9_]+/g, (m) => categoryLabel(m, names))
    .replace(/attributes\/[A-Za-z0-9_]+/g, (m) => attributeLabel(m));
}

/** A status inside a sentence: `pending_approval` as "pending approval". */
export const statusWords = (status: string): string => humanise(status).toLowerCase();
