import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { locations, profileSnapshots, reviews, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { marketForTimeZone } from "../config/writing-style";
import { upcomingHolidays } from "../config/holidays";
import { cityFromAddress } from "../posts/bulk/variables";
import { getWorkspaceReplySettings } from "../reviews/workspace-settings";
import { originalReviewText } from "../actions/aiReplies";
import { workspaceTimeZone } from "../actions/posts";

/** How much of the location's own material goes into a post prompt. Our choices, kept small on purpose. */
export const POST_SOURCE = {
  maxServices: 8,
  maxReviews: 4,
  reviewChars: 240,
  /** Positive reviews newer than this many days. */
  reviewDays: 120,
} as const;

export type PostSource = {
  locationId: string;
  name: string;
  city: string | null;
  services: string[];
  /** Short excerpts of recent 4 and 5 star reviews. No reviewer names. Empty for healthcare clients. */
  praise: string[];
  occasions: { date: string; name: string }[];
  market: ReturnType<typeof marketForTimeZone>;
};

function serviceNames(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  type Item = {
    freeFormServiceItem?: { label?: { displayName?: unknown } };
    structuredServiceItem?: { serviceTypeId?: unknown };
  };
  for (const i of items as Item[]) {
    const free = i?.freeFormServiceItem?.label?.displayName;
    const structured = i?.structuredServiceItem?.serviceTypeId;
    // A structured id looks like "job_type_id:hair_cut"; show the readable tail.
    const name =
      typeof free === "string"
        ? free
        : typeof structured === "string"
          ? structured.replace(/^.*:/, "").replace(/_/g, " ")
          : "";
    if (name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}

/** Today as YYYY-MM-DD in a time zone. */
export function todayIn(timeZone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * What the model may draw a post from for one location: services (newest profile snapshot), a few
 * recent positive review excerpts, and the market's upcoming occasions. Read only. A review's author
 * is never selected. A healthcare client (HIPAA pack) sends no review text at all, because a review
 * can carry a health detail.
 */
export async function loadPostSource(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  locationId: string,
  now = new Date(),
): Promise<PostSource | null> {
  const [loc] = await tx
    .select({ id: locations.id, name: locations.name, title: locations.title, addressSummary: locations.addressSummary })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.orgId, actor.orgId),
        eq(locations.workspaceId, workspaceId),
        eq(locations.status, "active"),
      ),
    );
  if (!loc) return null;

  const [snap] = await tx
    .select({ data: profileSnapshots.data })
    .from(profileSnapshots)
    .where(and(eq(profileSnapshots.orgId, actor.orgId), eq(profileSnapshots.locationId, locationId)))
    .orderBy(desc(profileSnapshots.takenAt))
    .limit(1);
  const fields = (snap?.data as { fields?: { serviceItems?: unknown } } | undefined)?.fields;
  const services = serviceNames(fields?.serviceItems).slice(0, POST_SOURCE.maxServices);

  const settings = await getWorkspaceReplySettings(tx, workspaceId);
  let praise: string[] = [];
  if (!settings.packs.includes("hipaa")) {
    const since = new Date(now.getTime() - POST_SOURCE.reviewDays * 86_400_000);
    const rows = await tx
      .select({ comment: reviews.comment })
      .from(reviews)
      .where(
        and(
          eq(reviews.locationId, locationId),
          isNotNull(reviews.comment),
          gte(reviews.starRating, 4),
          gte(reviews.createTime, since),
        ),
      )
      .orderBy(desc(reviews.createTime))
      .limit(POST_SOURCE.maxReviews * 3);
    praise = rows
      .map((r) => originalReviewText(r.comment ?? "").replace(/\s+/g, " ").trim().slice(0, POST_SOURCE.reviewChars))
      .filter((t) => t !== "")
      .slice(0, POST_SOURCE.maxReviews);
  }

  const timeZone = await workspaceTimeZone(tx, workspaceId);
  const market = marketForTimeZone(timeZone);
  return {
    locationId,
    name: loc.title ?? loc.name,
    city: cityFromAddress(loc.addressSummary),
    services,
    praise,
    occasions: upcomingHolidays(market, todayIn(timeZone, now)),
    market,
  };
}

/** The user message for a post prompt: fixed labelled lines, so the data is clearly data. */
export function postSourceText(s: PostSource, extra: string[] = []): string {
  return [
    "<source>",
    `Business: ${s.name}`,
    ...(s.city ? [`City: ${s.city}`] : []),
    ...(s.services.length ? [`Services: ${s.services.join("; ")}`] : []),
    ...(s.praise.length
      ? [
          "Recent positive customer feedback (use only as a general theme; never quote it or name anyone):",
          ...s.praise.map((p) => `- ${p}`),
        ]
      : []),
    ...(s.occasions.length ? [`Upcoming occasions: ${s.occasions.map((o) => `${o.name} (${o.date})`).join("; ")}`] : []),
    ...extra,
    "</source>",
  ].join("\n");
}
