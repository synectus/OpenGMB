import { POST_LIMITS } from "../../config/post-limits";
import { BULK_POST_LIMITS } from "../../config/bulk-post-limits";
import { zonedWallToUtc } from "../../time/wall";
import { BULK_COLUMNS, columnId, type BulkColumnKey } from "./columns";
import { parseCsv } from "./csv";
import { resolveVariables, type LocationVars } from "./variables";

export type BulkLocation = { id: string; name: string; title: string | null; vars: LocationVars };

export type BulkRowDraft = {
  locationId: string;
  topicType: "STANDARD" | "EVENT" | "OFFER";
  summary: string;
  cta: { actionType: (typeof POST_LIMITS.ctaActionTypes)[number]; url?: string } | null;
  event: { title: string; startDate: string; startTime?: string; endDate: string; endTime?: string } | null;
  offer: { couponCode?: string; redeemOnlineUrl?: string; termsConditions?: string } | null;
  media: { sourceUrl: string }[];
  /** ISO instant, or null. */
  scheduledFor: string | null;
};

export type BulkRow = {
  /** Line of the file the row starts on. */
  line: number;
  locationName: string | null;
  errors: string[];
  /** Set only when `errors` is empty. */
  draft: BulkRowDraft | null;
};

export type BulkParse = { errors: string[]; rows: BulkRow[] };

type Ctx = { locations: BulkLocation[]; timeZone: string; now: Date; maxRows?: number };

const GRACE_MS = 60_000; // the same grace posts.createDraft gives a send time
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const SCHEDULED = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
const TYPES = ["STANDARD", "EVENT", "OFFER"] as const;

const lc = (s: string) => s.trim().toLowerCase();

/** Match one cell against the workspace's active locations: id, then exact name or title. */
function findLocation(cell: string, locations: BulkLocation[]): { loc?: BulkLocation; error?: string } {
  const key = lc(cell);
  if (!key) return { error: "location is empty" };
  const byId = locations.find((l) => lc(l.id) === key);
  if (byId) return { loc: byId };
  const byName = locations.filter((l) => lc(l.name) === key || (l.title && lc(l.title) === key));
  if (byName.length === 1) return { loc: byName[0]! };
  if (byName.length > 1) return { error: `"${cell.trim()}" matches more than one location; use the location id` };
  return { error: `No location named "${cell.trim()}" in this client (it must be active)` };
}

function validUrl(s: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

/**
 * CSV text to one validated row per line. Pure: the caller supplies the locations (with their
 * variable values), the client's time zone and the clock. A problem in the file's shape is in
 * `errors` and no rows are built; a problem in one row is in that row's `errors`.
 */
export function buildBulkRows(text: string, ctx: Ctx): BulkParse {
  const fail = (m: string): BulkParse => ({ errors: [m], rows: [] });
  const maxRows = ctx.maxRows ?? BULK_POST_LIMITS.maxRows;
  if (text.length > BULK_POST_LIMITS.maxChars) return fail(`The file is too large (at most ${BULK_POST_LIMITS.maxChars} characters)`);
  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Could not read the file");
  }
  if (records.length === 0) return fail("The file is empty. Paste rows or upload a CSV with a header row");
  const [head, ...body] = records;
  const index = new Map<BulkColumnKey, number>();
  for (const [i, h] of head!.cells.entries()) {
    if (!h.trim()) continue;
    const col = BULK_COLUMNS.find((c) => c.names.some((n) => columnId(n) === columnId(h)));
    if (!col) return fail(`Unknown column "${h.trim()}". Columns: ${BULK_COLUMNS.map((c) => c.names[0]).join(", ")}`);
    if (index.has(col.key)) return fail(`The "${col.names[0]}" column appears twice`);
    index.set(col.key, i);
  }
  for (const c of BULK_COLUMNS) {
    if (c.required && !index.has(c.key)) return fail(`The file needs a "${c.names[0]}" column`);
  }
  if (body.length === 0) return fail("The file has a header but no rows");
  if (body.length > maxRows) return fail(`A file can have at most ${maxRows} rows (this one has ${body.length}). Split it`);

  const rows = body.map((rec): BulkRow => {
    const get = (k: BulkColumnKey) => (index.has(k) ? (rec.cells[index.get(k)!] ?? "").trim() : "");
    const errors: string[] = [];
    const { loc, error } = findLocation(get("location"), ctx.locations);
    if (error) errors.push(error);

    let topicType: BulkRowDraft["topicType"] = "STANDARD";
    const typeCell = get("type").toUpperCase();
    if (typeCell === "ALERT") errors.push("type ALERT is not available (Google has turned off new alerts)");
    else if (typeCell) {
      const t = TYPES.find((x) => x === typeCell);
      if (t) topicType = t;
      else errors.push(`type "${get("type")}" is not STANDARD, EVENT or OFFER`);
    }

    // Variables resolve in every free-text field; each problem is reported once for the row.
    const problems = new Set<string>();
    const fill = (value: string) => {
      if (!loc || !value) return value;
      const r = resolveVariables(value, loc.vars);
      r.errors.forEach((e) => problems.add(e));
      return r.text;
    };

    const summary = fill(get("summary"));
    if (!get("summary")) errors.push("summary is empty");

    let cta: BulkRowDraft["cta"] = null;
    const ctaCell = get("ctaType").toUpperCase().replace(/[\s-]+/g, "_");
    const ctaUrl = fill(get("ctaUrl"));
    if (ctaCell) {
      const a = POST_LIMITS.ctaActionTypes.find((x) => x === ctaCell);
      if (!a) errors.push(`CTA type "${get("ctaType")}" is not one of ${POST_LIMITS.ctaActionTypes.join(", ")}`);
      else cta = { actionType: a, ...(ctaUrl ? { url: ctaUrl } : {}) };
    } else if (ctaUrl) errors.push("cta_url is set but cta_type is empty");

    const media: BulkRowDraft["media"] = [];
    const image = fill(get("imageUrl"));
    if (image) {
      if (validUrl(image)) media.push({ sourceUrl: image });
      else errors.push("image_url must be a full http(s) link");
    }

    const dates: [BulkColumnKey, RegExp, string][] = [
      ["eventStartDate", DATE, "YYYY-MM-DD"],
      ["eventEndDate", DATE, "YYYY-MM-DD"],
      ["eventStartTime", TIME, "HH:MM"],
      ["eventEndTime", TIME, "HH:MM"],
    ];
    for (const [k, re, shape] of dates) {
      if (get(k) && !re.test(get(k))) {
        errors.push(`${BULK_COLUMNS.find((c) => c.key === k)!.names[0]} must look like ${shape}`);
      }
    }
    const eventTitle = fill(get("eventTitle"));
    const hasEvent = !!(eventTitle || get("eventStartDate") || get("eventEndDate") || get("eventStartTime") || get("eventEndTime"));
    const event: BulkRowDraft["event"] = hasEvent
      ? {
          title: eventTitle,
          startDate: get("eventStartDate"),
          endDate: get("eventEndDate"),
          ...(get("eventStartTime") ? { startTime: get("eventStartTime") } : {}),
          ...(get("eventEndTime") ? { endTime: get("eventEndTime") } : {}),
        }
      : null;
    const redeem = fill(get("redeemUrl"));
    const terms = fill(get("terms"));
    const hasOffer = !!(get("couponCode") || redeem || terms);
    const offer: BulkRowDraft["offer"] =
      hasOffer
        ? {
            ...(get("couponCode") ? { couponCode: get("couponCode") } : {}),
            ...(redeem ? { redeemOnlineUrl: redeem } : {}),
            ...(terms ? { termsConditions: terms } : {}),
          }
        : null;

    let scheduledFor: string | null = null;
    const when = get("scheduled");
    if (when) {
      const m = SCHEDULED.exec(when);
      const at = m ? zonedWallToUtc(`${m[1]}T${m[2]}`, ctx.timeZone) : null;
      if (!at) errors.push(`scheduled must be a real time like 2026-12-01 09:00 (YYYY-MM-DD HH:MM) in ${ctx.timeZone}`);
      else if (at.getTime() < ctx.now.getTime() - GRACE_MS) errors.push("scheduled is in the past");
      else scheduledFor = at.toISOString();
    }

    if (hasEvent && topicType === "STANDARD") errors.push("event_* columns need type EVENT or OFFER");
    if (hasOffer && topicType !== "OFFER") errors.push("coupon_code, redeem_url and terms need type OFFER");

    errors.push(...problems);
    return {
      line: rec.line,
      locationName: loc ? (loc.title ?? loc.name) : null,
      errors,
      draft:
        errors.length === 0 && loc
          ? {
              locationId: loc.id,
              topicType,
              summary,
              cta,
              event,
              offer,
              media,
              scheduledFor,
            }
          : null,
    };
  });
  return { errors: [], rows };
}
