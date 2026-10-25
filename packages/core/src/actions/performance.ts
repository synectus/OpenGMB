import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { locations } from "@opengmb/db";
import { AccessError, authorize, workspaceScope } from "../actor";
import { DAILY_METRICS } from "../google/client";
import { CoreError } from "../errors";
import { enqueueJob } from "../jobs";
import { addMonths, isYmd, lastCompleteMonth, monthsBetween } from "../performance/dates";
import { activity, byLocation, resolveLocationIds, summarize, topKeywords } from "../performance/queries";
import { PERFORMANCE_SNAPSHOT_QUEUE } from "../performance/snapshot";
import { defineAction } from "../registry";
import { PERFORMANCE_CONFIG } from "../config/performance";

const day = z.string().refine(isYmd, "Use YYYY-MM-DD");

/** Exactly one of workspaceId or locationIds. */
const scopeFields = {
  workspaceId: z.uuid().optional(),
  locationIds: z.array(z.uuid()).min(1).max(200).optional(),
};

function checkScopeInput(i: { workspaceId?: string; locationIds?: string[] }) {
  if (Boolean(i.workspaceId) === Boolean(i.locationIds)) {
    throw new CoreError("INVALID_INPUT", "Give either workspaceId or locationIds, not both");
  }
}

const deltaFields = {
  total: z.number(),
  previousTotal: z.number(),
  delta: z.number(),
  /** null when the previous period was zero. */
  deltaPct: z.number().nullable(),
};

export const performanceSummary = defineAction({
  name: "performance.summary",
  description:
    "Business Profile performance for a workspace (workspaceId) or specific locations (locationIds) over from..to (YYYY-MM-DD, inclusive): totals per metric and per KPI (impressions split Maps/Search, calls, website clicks, direction requests), each compared with the equal-length period just before it (delta and deltaPct, null when the earlier period was 0), and a daily series per KPI. Data is what the nightly snapshot captured; days Google omitted count as 0 and hasData is false when nothing was captured. Needs report:read.",
  input: z.object({ ...scopeFields, from: day, to: day }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    previousFrom: z.string(),
    previousTo: z.string(),
    locationCount: z.number(),
    hasData: z.boolean(),
    kpis: z.array(z.object({ key: z.string(), label: z.string(), ...deltaFields })),
    metrics: z.array(z.object({ metric: z.enum(DAILY_METRICS), ...deltaFields })),
    series: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        points: z.array(z.object({ date: z.string(), value: z.number() })),
      }),
    ),
  }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    checkScopeInput(input);
    if (input.workspaceId) authorize(actor, "report:read", { workspaceId: input.workspaceId });
    const { locationIds } = await resolveLocationIds(tx, actor, input);
    return summarize(tx, { locationIds, range: { from: input.from, to: input.to } });
  },
});

const keywordRow = z.object({
  keyword: z.string(),
  /** Sum of the exact monthly counts known; a floor when isLowerBound. */
  value: z.number(),
  isLowerBound: z.boolean(),
  /** Sum of the thresholds of months Google hid: each of those months was below its threshold. */
  hiddenBelow: z.number(),
});

export const performanceKeywords = defineAction({
  name: "performance.keywords",
  description:
    "Top Google search keywords (unique users who searched and saw the business) for a workspace or locations over the last `months` complete calendar months (default 3, ending at the previous month, or at endMonth YYYY-MM). Google hides small counts: such a month adds nothing to value and sets isLowerBound, with hiddenBelow the sum of thresholds (the real figure was below it). Needs report:read.",
  input: z.object({
    ...scopeFields,
    months: z.number().int().min(1).max(PERFORMANCE_CONFIG.retentionMonths.value).default(3),
    endMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: z.object({ months: z.array(z.string()), keywords: z.array(keywordRow) }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    checkScopeInput(input);
    if (input.workspaceId) authorize(actor, "report:read", { workspaceId: input.workspaceId });
    const { locationIds } = await resolveLocationIds(tx, actor, input);
    const end = input.endMonth ?? lastCompleteMonth(new Date());
    const months = monthsBetween(addMonths(end, -(input.months - 1)), end);
    return { months, keywords: await topKeywords(tx, { locationIds, months, limit: input.limit }) };
  },
});

export const performanceBackfill = defineAction({
  name: "performance.backfill",
  description:
    "Queue a re-fetch of a location's full Business Profile performance history (the last 18 months Google serves) and its monthly search keywords. Asynchronous: audits the request and queues a worker job in the same transaction. Existing stored days are overwritten with Google's current values; nothing is deleted. The location must be active and linked to Google. Needs report:manage.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ locationId: z.string(), jobId: z.string() }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [loc] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.id, input.locationId), eq(locations.orgId, actor.orgId)));
    const scope = workspaceScope(actor);
    if (!loc || (scope !== "all" && !scope.includes(loc.workspaceId))) {
      throw new AccessError("NOT_FOUND", "Location not found");
    }
    authorize(actor, "report:manage", { workspaceId: loc.workspaceId });
    if (loc.status !== "active") throw new CoreError("CONFLICT", "Location is inactive");
    if (!loc.googleLocationId || !loc.connectionId) {
      throw new CoreError("CONFLICT", "Location is not linked to a Google connection");
    }
    const jobId = await enqueueJob(tx, PERFORMANCE_SNAPSHOT_QUEUE, {
      locationId: loc.id,
      backfill: true,
    });
    await audit({
      action: "performance.backfill_requested",
      entityType: "location",
      entityId: loc.id,
      before: null,
      after: { jobId },
    });
    return { locationId: loc.id, jobId };
  },
});

const deltaOut = z.object(deltaFields);

export const performanceByLocation = defineAction({
  name: "performance.byLocation",
  description:
    "Per-location calls, website clicks and direction requests for a workspace (workspaceId) or locations (locationIds) over from..to (YYYY-MM-DD, inclusive), each compared with the equal-length period just before, plus `actions` (the three added together), the location's status, needsRelink (Google was disconnected), lastDataDate (newest stored day) and googleAccessDenied (Google refuses to share performance data for this location with the connected account; re-checked every few days). Ordered by title. Needs report:read.",
  input: z.object({ ...scopeFields, from: day, to: day }),
  output: z.object({
    rows: z.array(
      z.object({
        locationId: z.string(),
        title: z.string(),
        status: z.enum(["active", "inactive"]),
        needsRelink: z.boolean(),
        lastDataDate: z.string().nullable(),
        googleAccessDenied: z.boolean(),
        calls: deltaOut,
        websiteClicks: deltaOut,
        directions: deltaOut,
        actions: deltaOut,
      }),
    ),
  }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    checkScopeInput(input);
    if (input.workspaceId) authorize(actor, "report:read", { workspaceId: input.workspaceId });
    const { locationIds } = await resolveLocationIds(tx, actor, input);
    return { rows: await byLocation(tx, { locationIds, range: { from: input.from, to: input.to } }) };
  },
});

export const performanceActivity = defineAction({
  name: "performance.activity",
  description:
    "Reviews and posts for a workspace (workspaceId) or locations (locationIds) over from..to (YYYY-MM-DD, inclusive, UTC): newReviews (created in the range), averageRating (of those, one decimal, null when none is rated), unreplied (of those, reviews that still need a reply, by the shared reply-stage rule) and postsPublished (distinct posts published in the range). Counts only, never review text. Needs review:read.",
  input: z.object({ ...scopeFields, from: day, to: day }),
  output: z.object({
    newReviews: z.number(),
    averageRating: z.number().nullable(),
    unreplied: z.number(),
    postsPublished: z.number(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    checkScopeInput(input);
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const { locationIds } = await resolveLocationIds(tx, actor, input);
    return activity(tx, { locationIds, range: { from: input.from, to: input.to } });
  },
});
