import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { locations, reviews, type Tx } from "@opengmb/db";
import { authorize, type Actor } from "../actor";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { ANALYTICS_CONFIG, computeAnalytics, type AnalyticsRow } from "../reviews/analytics";
import { rowHasNoVisibleReply } from "../reviews/reply-stage";
import { filterConditions, scopeConditions, type ReviewFilters } from "../reviews/queries";

const isoDate = z.iso.datetime({ offset: true });
const totalsOut = z.object({
  count: z.number().int(),
  rated: z.number().int(),
  avgRating: z.number().nullable(),
  replied: z.number().int(),
  replyRate: z.number().nullable(),
  medianReplyHours: z.number().nullable(),
  needsReply: z.number().int(),
});
const trendOut = z.enum(["up", "down", "flat", "none"]);

/** Narrow columns only: no comment, no reviewer, no reply text. */
async function rowsFor(tx: Tx, actor: Actor, f: ReviewFilters, from: Date, to: Date) {
  const found = await tx
    .select({
      locationId: reviews.locationId,
      locationName: locations.name,
      createTime: reviews.createTime,
      rating: reviews.starRating,
      replyComment: reviews.replyComment,
      replyState: reviews.replyState,
      replyUpdateTime: reviews.replyUpdateTime,
    })
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .where(and(...scopeConditions(actor), ...filterConditions(actor, { ...f, from, to })))
    .orderBy(desc(reviews.createTime))
    .limit(ANALYTICS_CONFIG.maxRows + 1);
  const truncated = found.length > ANALYTICS_CONFIG.maxRows;
  const names = new Map<string, string>();
  const rows: AnalyticsRow[] = (truncated ? found.slice(0, ANALYTICS_CONFIG.maxRows) : found).map((r) => {
    names.set(r.locationId, r.locationName);
    const replied = !rowHasNoVisibleReply(r);
    const hours = replied && r.replyUpdateTime ? (r.replyUpdateTime.getTime() - r.createTime.getTime()) / 3_600_000 : null;
    return {
      locationId: r.locationId,
      createTime: r.createTime,
      rating: r.rating,
      replied,
      replyHours: hours !== null && hours >= 0 ? hours : null,
    };
  });
  return { rows, names, truncated };
}

export const reviewsAnalytics = defineAction({
  name: "reviews.analytics",
  description:
    "Review analytics by plain arithmetic over synced reviews, no AI: for the window from (inclusive) to (exclusive), ISO datetimes, at most 800 days, and the equally long window right before it. Returns totals (count, average rating to one decimal, reply rate 0 to 1, median hours from review to reply using Google's reply update time, number needing a reply: no reply or a reply Google rejected), new reviews and average rating per UTC month, the star distribution, and per location totals with a rating trend. Filters: workspaceId, locationIds, groupId. Active locations in the caller's workspaces only. Returns no review text, reviewer names or reply text. truncated is true when a window held more than 50,000 reviews.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(100).optional(),
    groupId: z.uuid().optional(),
    from: isoDate,
    to: isoDate,
  }),
  output: z.object({
    period: z.object({ from: z.string(), to: z.string(), previousFrom: z.string(), previousTo: z.string() }),
    current: totalsOut,
    previous: totalsOut,
    months: z.array(z.object({ month: z.string(), total: z.number().int(), low: z.number().int(), avg: z.number().nullable() })),
    stars: z.array(z.object({ star: z.number().int(), count: z.number().int() })),
    locations: z.array(
      totalsOut.extend({
        locationId: z.string(),
        name: z.string(),
        trend: trendOut,
        monthly: z.array(z.number().nullable()),
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (!(from < to)) throw new CoreError("INVALID_INPUT", "from must be before to");
    if ((to.getTime() - from.getTime()) / 86_400_000 > ANALYTICS_CONFIG.maxDays) {
      throw new CoreError("INVALID_INPUT", `The range is longer than ${ANALYTICS_CONFIG.maxDays} days`);
    }
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const f: ReviewFilters = { workspaceId: input.workspaceId, locationIds: input.locationIds, groupId: input.groupId };
    const len = to.getTime() - from.getTime();
    const cur = await rowsFor(tx, actor, f, from, to);
    const prev = await rowsFor(tx, actor, f, new Date(from.getTime() - len), from);
    const names = new Map([...prev.names, ...cur.names]);
    return {
      ...computeAnalytics({ rows: cur.rows, previousRows: prev.rows, names, from, to }),
      truncated: cur.truncated || prev.truncated,
    };
  },
});
