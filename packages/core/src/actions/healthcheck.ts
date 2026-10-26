import { and, asc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { healthcheckSkips, locations, reviews, searchKeywordsMonthly, users, type Db } from "@opengmb/db";
import { authorize } from "../actor";
import { narrowTo } from "../approval-queue";
import { HEALTHCHECK_CONFIG as CFG } from "../config/healthcheck";
import { PROFILE_LIMITS } from "../config/profile-limits";
import {
  CHECK_IDS,
  evaluateHealth,
  scoreOf,
  type Check,
  type HealthInput,
  type Src,
} from "../healthcheck/evaluate";
import { clientForLocation, googleNames, loadLocation, type LocRow } from "../locationOps/access";
import { defineAction } from "../registry";
import { needsYouSql, waitingToPublishSql } from "../reviews/reply-stage";
import { getCompetitorCategories } from "../competitors/categories";
import { GoogleOrgLimitError } from "../google/errors";
import type { GooglePlaceActionLink } from "../google/client";
import {
  clearGoogleAccessDenied,
  isGoogleAccessBlocked,
  isLocationAccessDenied,
  markGoogleAccessDenied,
} from "../locations/data-access";
import { listAllMedia } from "./media";
import { locationScope } from "./locations";

const checkOut = z.object({
  id: z.string(),
  title: z.string(),
  importance: z.enum(["necessary", "important", "nice"]),
  status: z.enum(["pass", "fail", "unknown", "skipped"]),
  /** Plain language: what we found. */
  detail: z.string(),
  /** An in-app route that fixes it, or null when nothing in the app can. */
  fix: z.object({ label: z.string(), href: z.string() }).nullable(),
  /** Who skipped this check and when; null when it is not skipped. */
  skipped: z.object({ byName: z.string().nullable(), at: z.string() }).nullable(),
});
const scoreOut = z.object({ passed: z.number(), total: z.number(), percent: z.number() });

type GoogleClientFor = Awaited<ReturnType<typeof clientForLocation>>;

/** One Google read, or `ok: false` when it throws: a failed read must only make its own checks unknown. */
async function safe<T>(read: () => Promise<T>): Promise<Src<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return e instanceof GoogleOrgLimitError ? { ok: false, limited: e.message } : { ok: false };
  }
}

/** OPS2: the place action links read, skipped while Google refuses this location's links (marked on a plain 403). */
async function placeActionLinks(
  db: Db,
  loc: LocRow,
  viaGoogle: <T>(
    read: (c: GoogleClientFor, n: { locationName: string; parent: string }) => Promise<T>,
  ) => Promise<Src<T>>,
  /** False for a read-only view (view as customer): the marker is neither set nor cleared. */
  record: boolean,
): Promise<Src<GooglePlaceActionLink[]>> {
  if (await isGoogleAccessBlocked(db, loc.id, "place_actions")) return { ok: false };
  const res = await viaGoogle(async (c, n) => {
    try {
      return (await c.listPlaceActionLinks(n.locationName, { pageSize: 1 })).placeActionLinks;
    } catch (e) {
      if (isLocationAccessDenied(e)) {
        if (record) await markGoogleAccessDenied(db, loc, "place_actions");
        return null;
      }
      throw e;
    }
  });
  if (!res.ok) return res;
  if (res.value === null) return { ok: false };
  if (record) await clearGoogleAccessDenied(db, loc.id, "place_actions");
  return { ok: true, value: res.value };
}

async function reviewStats(db: Db, locationId: string, now: Date): Promise<HealthInput["reviews"]> {
  const since = new Date(now.getTime() - CFG.reviewWindowDays * 86_400_000).toISOString();
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      avg: sql<string | null>`avg(${reviews.starRating})`,
      unreplied: sql<number>`(count(*) filter (where ${needsYouSql} and ${reviews.createTime} >= ${since}::timestamptz))::int`,
      waitingToPublish: sql<number>`(count(*) filter (where ${waitingToPublishSql} and ${reviews.createTime} >= ${since}::timestamptz))::int`,
      newInWindow: sql<number>`(count(*) filter (where ${reviews.createTime} >= ${since}::timestamptz))::int`,
    })
    .from(reviews)
    .where(eq(reviews.locationId, locationId));
  return {
    total: r!.total,
    avgRating: r!.avg === null ? null : Number(r!.avg),
    unreplied: r!.unreplied,
    waitingToPublish: r!.waitingToPublish,
    newInWindow: r!.newInWindow,
  };
}

/** Top search terms over the last `keywordMonths` months from stored Performance data (known counts only). */
async function topSearchTerms(db: Db, locationId: string, now: Date): Promise<string[]> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - CFG.keywordMonths, 1))
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({ keyword: searchKeywordsMonthly.keyword })
    .from(searchKeywordsMonthly)
    .where(
      and(
        eq(searchKeywordsMonthly.locationId, locationId),
        gte(searchKeywordsMonthly.month, from),
        isNotNull(searchKeywordsMonthly.value),
      ),
    )
    .groupBy(searchKeywordsMonthly.keyword)
    .orderBy(sql`sum(${searchKeywordsMonthly.value}) desc`, searchKeywordsMonthly.keyword)
    .limit(CFG.keywordTopN);
  return rows.map((r) => r.keyword);
}

/** The caller's other active locations (their own scope, so a client never sees another workspace's names). */
async function otherListings(db: Db, actor: Parameters<typeof clientForLocation>[1], loc: LocRow) {
  const rows = await db
    .select({ id: locations.id, name: locations.name, address: locations.addressSummary, phone: locations.phone })
    .from(locations)
    .where(and(locationScope(actor), eq(locations.status, "active"), ne(locations.id, loc.id)));
  return rows;
}

/**
 * Every input the checks need: Google reads in parallel, each isolated (a failed read only makes its
 * own checks unknown), and reviews from our synced copy. Also used by locations.overview, so one
 * Overview view costs one pass of Google reads.
 */
export async function readHealthInputs(
  db: Db,
  actor: Parameters<typeof clientForLocation>[1],
  loc: LocRow,
): Promise<{ input: HealthInput; now: Date }> {
  const now = new Date();
  const g = await safe(async () => ({
    client: await clientForLocation(db, actor, loc),
    ...googleNames(loc),
  }));
  const viaGoogle = <T>(
    read: (c: GoogleClientFor, n: { locationName: string; parent: string }) => Promise<T>,
  ) => (g.ok ? safe(() => read(g.value.client, g.value)) : Promise.resolve<Src<T>>({ ok: false, limited: g.limited }));

  const [location, media, posts, voice, links, attributes, reviewData, keywords, others, competitorCats] = await Promise.all([
    viaGoogle((c, n) => c.getLocation(n.locationName, { readMask: PROFILE_LIMITS.readMask })),
    viaGoogle((c, n) => listAllMedia(c, n.parent)),
    // Newest first per Google; only the first page is needed.
    viaGoogle(
      async (c, n) =>
        (await c.listLocalPosts(n.parent, { pageSize: CFG.postsPageSize })).localPosts,
    ),
    viaGoogle((c, n) => c.getVoiceOfMerchantState(n.locationName)),
    placeActionLinks(db, loc, viaGoogle, !actor.readOnly),
    viaGoogle(
      async (c, n) => (await c.getAttributes(`${n.locationName}/attributes`)).attributes ?? [],
    ),
    reviewStats(db, loc.id, now),
    topSearchTerms(db, loc.id, now),
    otherListings(db, actor, loc),
    getCompetitorCategories(db, loc.orgId, loc.id),
  ]);
  return {
    input: {
      locationId: loc.id,
      location,
      media,
      posts,
      voice,
      links,
      attributes,
      keywords,
      listing: { name: loc.name, address: loc.addressSummary, phone: loc.phone },
      others,
      competitors: { dataSource: competitorCats.dataSource, rows: competitorCats.competitors },
      reviews: reviewData,
    },
    now,
  };
}

export type SkippedCheck = Check & { skipped: { byName: string | null; at: string } | null };

/** evaluateHealth plus this location's skips: a skipped check gets status "skipped". Used by healthcheck, summary and overview. */
export async function checksWithSkips(db: Db, input: HealthInput, now: Date): Promise<SkippedCheck[]> {
  const rows = await db
    .select({ checkId: healthcheckSkips.checkId, at: healthcheckSkips.skippedAt, byName: users.name })
    .from(healthcheckSkips)
    .leftJoin(users, eq(users.id, healthcheckSkips.skippedBy))
    .where(eq(healthcheckSkips.locationId, input.locationId));
  return evaluateHealth(input, now).map((c) => {
    const s = rows.find((r) => r.checkId === c.id);
    return s
      ? { ...c, status: "skipped" as const, skipped: { byName: s.byName ?? null, at: s.at.toISOString() } }
      : { ...c, skipped: null };
  });
}

/** Reads everything the checks need and evaluates it. */
async function runHealthcheck(db: Db, actor: Parameters<typeof clientForLocation>[1], loc: LocRow) {
  const { input, now } = await readHealthInputs(db, actor, loc);
  const checks = await checksWithSkips(db, input, now);
  return {
    location: { id: loc.id, name: loc.name, workspaceId: loc.workspaceId },
    score: scoreOf(checks),
    checks,
    checkedAt: now.toISOString(),
  };
}

export const locationsHealthcheck = defineAction({
  name: "locations.healthcheck",
  description: `Healthcheck of one location: a checklist of listing quality (description and its quality and use of your top search keywords, possible duplicate of another of your locations, categories, hours, phone, website, photos, posts, reviews, verification, place action links, attributes, services) with a score and a fix link for each failing check. Reads the profile, photos, posts, verification, place action links and attributes live from Google (outside any transaction) and reviews from our synced copy. Each check has an importance (necessary, important, nice), a status (pass, fail, unknown = the Google read failed, left out of the score) and a plain-language detail. score = passed / (passed + failed). Thresholds are our own choices (photo count, post age, rating ...), see config/healthcheck.ts. A check someone skipped (locations.healthcheckSkip) has status skipped and is left out of the score. Read only.`,
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    score: scoreOut,
    checks: z.array(checkOut),
    checkedAt: z.string(),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    return runHealthcheck(db, actor, loc);
  },
});

const IMPORTANCE_RANK = { necessary: 0, important: 1, nice: 2 } as const;

export const locationsHealthcheckSummary = defineAction({
  name: "locations.healthcheckSummary",
  description: `Runs the healthcheck (see locations.healthcheck) for each active, Google-linked location in the caller's scope, one after another, and returns per location its score and how many necessary checks fail, worst score first. Each location also lists its failing checks (id, title, importance; necessary first) and checkedAt. Optional workspaceId. Runs one page of ${CFG.summaryPageSize} locations (our choice: each costs about 7 Google reads), by name; \`offset\` (default 0) is where the page starts and \`total\` is how many locations are in scope, so offset + locations.length < total means more pages follow. Optional locationIds (up to 500) or groupId narrows what is paged (a location or group scope). Client roles only see their own workspaces. Read only.`,
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).min(1).max(500).optional(),
    /** The locations of this group, resolved here (a group scope of any size); instead of locationIds, not with it. */
    groupId: z.uuid().optional(),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    locations: z.array(
      z.object({
        locationId: z.string(),
        name: z.string(),
        score: scoreOut,
        failingNecessary: z.number(),
        /** Failing checks, necessary first, then important, then nice; each in CHECK_IDS order. */
        failing: z.array(
          z.object({ id: z.string(), title: z.string(), importance: z.enum(["necessary", "important", "nice"]) }),
        ),
        checkedAt: z.string(),
      }),
    ),
    total: z.number(),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const narrow = narrowTo(actor, input);
    const rows = await db
      .select()
      .from(locations)
      .where(
        and(
          locationScope(actor),
          eq(locations.status, "active"),
          isNotNull(locations.googleLocationId),
          isNotNull(locations.connectionId),
          input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
          narrow ? inArray(locations.id, narrow) : undefined,
        ),
      )
      .orderBy(asc(locations.name), asc(locations.id));
    const out: {
      locationId: string;
      name: string;
      score: { passed: number; total: number; percent: number };
      failingNecessary: number;
      failing: { id: string; title: string; importance: Check["importance"] }[];
      checkedAt: string;
    }[] = [];
    for (const loc of rows.slice(input.offset, input.offset + CFG.summaryPageSize)) {
      const h = await runHealthcheck(db, actor, loc);
      out.push({
        locationId: loc.id,
        name: loc.name,
        score: h.score,
        failingNecessary: h.checks.filter(
          (c: Check) => c.importance === "necessary" && c.status === "fail",
        ).length,
        failing: h.checks
          .filter((c: Check) => c.status === "fail")
          .sort((a: Check, b: Check) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance])
          .map((c: Check) => ({ id: c.id, title: c.title, importance: c.importance })),
        checkedAt: h.checkedAt,
      });
    }
    out.sort(
      (a, b) =>
        a.score.percent - b.score.percent ||
        b.failingNecessary - a.failingNecessary ||
        a.name.localeCompare(b.name),
    );
    return { locations: out, total: rows.length };
  },
});

export const locationsHealthcheckSkip = defineAction({
  name: "locations.healthcheckSkip",
  description: `Skip one health check for one location (skipped true) or undo it (false). A skipped check shows as skipped and is left out of the location's score everywhere (healthcheck, healthcheckSummary, overview) until undone. checkId is one of: ${CHECK_IDS.join(", ")}. Idempotent. Writes nothing to Google.`,
  input: z.object({ locationId: z.uuid(), checkId: z.enum(CHECK_IDS), skipped: z.boolean() }),
  output: z.object({ locationId: z.string(), checkId: z.string(), skipped: z.boolean() }),
  permission: "location:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "location:manage");
    if (input.skipped) {
      await tx
        .insert(healthcheckSkips)
        .values({ orgId: actor.orgId, locationId: loc.id, checkId: input.checkId, skippedBy: actor.userId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(healthcheckSkips)
        .where(and(eq(healthcheckSkips.locationId, loc.id), eq(healthcheckSkips.checkId, input.checkId)));
    }
    await audit({
      action: input.skipped ? "location.healthcheck_skip" : "location.healthcheck_unskip",
      entityType: "location",
      entityId: loc.id,
      before: null,
      after: { checkId: input.checkId },
    });
    return { locationId: loc.id, checkId: input.checkId, skipped: input.skipped };
  },
});
