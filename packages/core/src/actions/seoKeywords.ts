import { and, desc, eq, getTableColumns, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, platformDfsSpend, seoKeywordResearchRuns, workspaces, type Db, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { usdToMicro } from "../ai/money";
import { assertCredit, availableCreditUsd } from "../billing";
import { DFS_COUNTRY_LOCATIONS } from "../config/dfs-locations";
import { SEO_KEYWORDS, SEO_PRICES } from "../config/seo";
import { CoreError } from "../errors";
import { notifyBudgetExceeded } from "../geogrid/budget-alert";
import { BudgetExceededError, PlatformCapExceededError, assertWithinBudget, assertWithinPlatformCap, getGridBilling, monthToDateUsd } from "../geogrid/cost";
import { rankSource } from "../geogrid/drivers/source";
import { enqueueJob } from "../jobs";
import { roleHasPermission } from "../permissions";
import { defineAction } from "../registry";
import { cacheKey, researchEstimateUsd } from "../seo/keywords/estimate";
import { cityExists, searchCities } from "../seo/keywords/cities";
import { fixtureGeoRows } from "../seo/keywords/fixtures";
import { SEO_KEYWORDS_QUEUE } from "../seo/keywords/run";

const COUNTRIES = Object.keys(DFS_COUNTRY_LOCATIONS.codes) as [string, ...string[]];

const query = z.object({
  workspaceId: z.uuid(),
  locationId: z.uuid().optional(),
  seed: z.string().trim().min(2).max(80),
  countryIso: z.enum(COUNTRIES),
  /** DataForSEO geotarget name from seo.cities.search; omit for national volume only. */
  city: z.string().trim().min(2).max(200).optional(),
  rows: z.number().int().min(SEO_KEYWORDS.minRows).max(SEO_KEYWORDS.maxRows).default(SEO_KEYWORDS.defaultRows),
});
type Query = z.output<typeof query>;

async function loadWorkspace(tx: Tx | Db, actor: Actor, workspaceId: string, permission: "geogrid:read" | "geogrid:manage" | "geogrid:cost") {
  const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
  authorize(actor, permission, { workspaceId });
}

/**
 * A stored result that makes a repeat free: a `done` run with rows and no missing-city-volume note, newer than the cache
 * window; or an in-flight run (queued or running, not yet stale) with the same query, so a double click buys one search.
 */
async function findCached(tx: Tx | Db, actor: Actor, q: Query, now: Date) {
  const since = new Date(now.getTime() - SEO_KEYWORDS.cacheDays * 86_400_000);
  const inFlightSince = new Date(now.getTime() - SEO_KEYWORDS.sweepQueuedAfterMs);
  const key = cacheKey({ workspaceId: q.workspaceId, seed: q.seed, countryIso: q.countryIso, city: q.city ?? null, rows: q.rows });
  const candidates = await tx
    .select({
      id: seoKeywordResearchRuns.id,
      status: seoKeywordResearchRuns.status,
      createdAt: seoKeywordResearchRuns.createdAt,
      note: seoKeywordResearchRuns.localVolumeNote,
      n: sql<number>`jsonb_array_length(${seoKeywordResearchRuns.rows})`,
    })
    .from(seoKeywordResearchRuns)
    .where(
      and(
        eq(seoKeywordResearchRuns.orgId, actor.orgId),
        eq(seoKeywordResearchRuns.cacheKey, key),
        inArray(seoKeywordResearchRuns.status, ["done", "queued", "running"]),
        // A sample-data result never stands in for a real one.
        eq(seoKeywordResearchRuns.dataSource, rankSource()),
        gte(seoKeywordResearchRuns.createdAt, since),
      ),
    )
    .orderBy(desc(seoKeywordResearchRuns.createdAt))
    .limit(10);
  return candidates.find((c) => (c.status === "done" ? c.n > 0 && c.note === null : c.createdAt >= inFlightSince)) ?? null;
}

async function price(tx: Tx | Db, orgId: string, q: Query) {
  const providerUsd = researchEstimateUsd({ rows: q.rows, city: !!q.city });
  const markup = (await getGridBilling(tx, orgId)).markupPercent;
  // Whole cents, rounded up: the reserve, the cap, the price shown and the MCP preview are one number.
  return { providerUsd, chargedUsd: Math.ceil(Math.round(providerUsd * (1 + markup / 100) * 1e4) / 100) / 100 };
}

const estimateOut = z.object({
  providerUsd: z.number(),
  chargedUsd: z.number(),
  cached: z.boolean(),
  cachedRunId: z.string().nullable(),
  cachedAt: z.string().nullable(),
  /** True when the reused search is still queued or running (nothing more to pay), false for a stored result. */
  inFlight: z.boolean(),
  /** Data source right now: fixture and sandbox are never charged. */
  source: z.enum(["fixture", "sandbox", "live"]),
  /** Credit left after queued searches; null when billing is off. */
  balanceUsd: z.number().nullable(),
  monthToDateUsd: z.number(),
  monthlyBudgetUsd: z.number(),
  remainingBudgetUsd: z.number(),
  wouldExceed: z.boolean(),
  priceSourceUrls: z.array(z.string()),
  priceVerifiedOn: z.string(),
});

export const seoKeywordsEstimate = defineAction({
  name: "seo.keywords.estimate",
  description:
    "Price of a keyword research search before it runs: the DataForSEO cost (providerUsd) and what the organization is charged with its markup (chargedUsd), the credit balance, this month's spend against the monthly budget, and whether the search would exceed it. A search repeated within 7 days is free (cached true, prices 0). Takes workspaceId, seed, countryIso (IN, US, AU, GB, CA, NZ, AE), an optional city (a geotarget name such as 'Austin,Texas,United States') and rows (20 to 300, default 150). Reads stored data only. Needs geogrid:cost (owner, admin, manager; hidden from client roles).",
  input: query,
  output: estimateOut,
  permission: "geogrid:cost",
  kind: "read",
  async handler({ tx, actor }, input) {
    await loadWorkspace(tx, actor, input.workspaceId, "geogrid:cost");
    const now = new Date();
    const cached = await findCached(tx, actor, input, now);
    const p = await price(tx, actor.orgId, input);
    const billing = await getGridBilling(tx, actor.orgId);
    const spent = await monthToDateUsd(tx, actor.orgId, now);
    const charged = cached ? 0 : p.chargedUsd;
    const remaining = billing.monthlyBudgetUsd - spent;
    return {
      providerUsd: cached ? 0 : p.providerUsd,
      chargedUsd: charged,
      cached: !!cached,
      cachedRunId: cached?.id ?? null,
      cachedAt: cached ? cached.createdAt.toISOString() : null,
      inFlight: !!cached && cached.status !== "done",
      source: rankSource(),
      balanceUsd: await availableCreditUsd(tx, actor.orgId, now),
      monthToDateUsd: spent,
      monthlyBudgetUsd: billing.monthlyBudgetUsd,
      remainingBudgetUsd: remaining,
      wouldExceed: rankSource() === "live" && charged > remaining + 1e-9,
      priceSourceUrls: [SEO_PRICES.labs.sourceUrl, SEO_PRICES.googleAdsLive.sourceUrl],
      priceVerifiedOn: SEO_PRICES.labs.verifiedOn,
    };
  },
});

export const seoKeywordsResearch = defineAction({
  name: "seo.keywords.research",
  description:
    "Run keyword research for a seed keyword in one country (IN, US, AU, GB, CA, NZ, AE), optionally with monthly search volume for one city (a geotarget name such as 'Austin,Texas,United States' from the city search). Returns up to 300 ideas with national keyword difficulty, intent and CPC, and the city's monthly volume. Costs DataForSEO credit, charged to the organization's credit with its markup: maxChargeUsd is required and the call is refused when the current price is higher, so pass the price you were shown. Results arrive asynchronously and are read with seo.keywords.get. A search repeated within 7 days returns the stored result at no cost. Needs geogrid:manage (owner, admin, manager).",
  input: query.extend({ maxChargeUsd: z.number().min(0) }),
  output: z.object({ runId: z.string(), status: z.enum(["queued", "running", "done", "failed"]), cached: z.boolean(), chargedUsd: z.number() }),
  permission: "geogrid:manage",
  kind: "write",
  async preview(ctx, input) {
    const e = (await ctx.read("seo.keywords.estimate", input)) as z.output<typeof estimateOut>;
    const where = input.city ? input.city.replaceAll(",", ", ") : input.countryIso;
    const max = `$${input.maxChargeUsd.toFixed(2)}`;
    const live = e.source === "live";
    const from = e.balanceUsd === null ? "" : " from your credit";
    const cost = e.cached
      ? live
        ? `free now (stored result from ${e.cachedAt?.slice(0, 10)}); at most ${max}${from} if the stored result has expired when this is applied`
        : `free now (stored result from ${e.cachedAt?.slice(0, 10)})`
      : live
        ? `$${e.chargedUsd.toFixed(2)}${from}`
        : `free in ${e.source} mode (the live price would be $${e.chargedUsd.toFixed(2)})`;
    return { summary: `Keyword research for "${input.seed}" in ${where}: ${cost}`, diff: e };
  },
  async handler({ tx, db, actor, audit }, input) {
    await loadWorkspace(tx, actor, input.workspaceId, "geogrid:manage");
    if (input.locationId) {
      const [loc] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.id, input.locationId), eq(locations.orgId, actor.orgId), eq(locations.workspaceId, input.workspaceId)));
      if (!loc) throw new CoreError("NOT_FOUND", "Location not found");
    }
    const source = rankSource();
    if (input.city) {
      const known = (await cityExists(tx, { countryIso: input.countryIso, name: input.city })) || (source === "fixture" && fixtureGeoRows(input.countryIso).some((g) => g.location_name === input.city));
      if (!known) throw new CoreError("INVALID_INPUT", "Pick a city from the list");
    }
    const now = new Date();
    let cached = await findCached(tx, actor, input, now);
    if (!cached) {
      // Two identical requests at once: the second waits here, then finds the first one's run and reuses it.
      const key = cacheKey({ workspaceId: input.workspaceId, seed: input.seed, countryIso: input.countryIso, city: input.city ?? null, rows: input.rows });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('seo.keywords:' || ${key}))`);
      cached = await findCached(tx, actor, input, now);
    }
    if (cached) {
      await audit({ action: "seo.keyword_research.reopened", entityType: "workspace", entityId: input.workspaceId, before: null, after: { runId: cached.id, seed: input.seed } });
      return { runId: cached.id, status: cached.status, cached: true, chargedUsd: 0 };
    }

    const { providerUsd, chargedUsd } = await price(tx, actor.orgId, input);
    if (chargedUsd > input.maxChargeUsd + 1e-9) {
      throw new CoreError("INVALID_INPUT", `The price is now $${chargedUsd.toFixed(2)}. Check the estimate and try again.`);
    }
    let spendId: string | null = null;
    if (source === "live") {
      try {
        await assertWithinBudget(tx, actor.orgId, chargedUsd, now);
        await assertCredit(tx, actor.orgId, usdToMicro(chargedUsd), now);
        await assertWithinPlatformCap(tx, providerUsd, now);
      } catch (e) {
        // The action's transaction rolls back on the throw, so the owner alert goes in its own transaction first.
        if (e instanceof BudgetExceededError || e instanceof PlatformCapExceededError) {
          const scope = e instanceof PlatformCapExceededError ? "platform" : "org";
          await db.transaction((t) => notifyBudgetExceeded(t, { orgId: actor.orgId, scope, audit: false }));
        }
        throw e;
      }
      const [s] = await tx.insert(platformDfsSpend).values({ kind: "seo_keywords", costUsd: providerUsd.toFixed(4) }).returning({ id: platformDfsSpend.id });
      spendId = s!.id;
    }
    const [run] = await tx
      .insert(seoKeywordResearchRuns)
      .values({
        orgId: actor.orgId,
        workspaceId: input.workspaceId,
        locationId: input.locationId ?? null,
        seed: input.seed,
        countryIso: input.countryIso,
        languageCode: SEO_KEYWORDS.languageCode,
        cityLocationName: input.city ?? null,
        rowLimit: input.rows,
        cacheKey: cacheKey({ workspaceId: input.workspaceId, seed: input.seed, countryIso: input.countryIso, city: input.city ?? null, rows: input.rows }),
        dataSource: source,
        status: "queued",
        estimateChargeUsd: chargedUsd.toFixed(4),
        spendId,
        createdBy: actor.userId,
      })
      .returning({ id: seoKeywordResearchRuns.id });
    await enqueueJob(tx, SEO_KEYWORDS_QUEUE, { runId: run!.id });
    await audit({
      action: "seo.keyword_research.requested",
      entityType: "workspace",
      entityId: input.workspaceId,
      before: null,
      after: { seed: input.seed, countryIso: input.countryIso, city: input.city ?? null, rows: input.rows, estimateChargeUsd: chargedUsd },
    });
    return { runId: run!.id, status: "queued" as const, cached: false, chargedUsd: source === "live" ? chargedUsd : 0 };
  },
});

const rowOut = z.object({
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  trend: z.array(z.object({ year: z.number(), month: z.number(), searchVolume: z.number() })),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
  intent: z.enum(["informational", "commercial", "transactional", "navigational", "unknown"]),
  localVolume: z.number().nullable().optional(),
  localCpc: z.number().nullable().optional(),
});

const runOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  locationId: z.string().nullable(),
  seed: z.string(),
  countryIso: z.string(),
  city: z.string().nullable(),
  rowLimit: z.number(),
  dataSource: z.enum(["fixture", "sandbox", "live"]),
  status: z.enum(["queued", "running", "done", "failed"]),
  /** Null unless the role has geogrid:cost. */
  chargedUsd: z.number().nullable(),
  localVolumeNote: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  rowCount: z.number(),
});

export const seoKeywordsGet = defineAction({
  name: "seo.keywords.get",
  description:
    "Read keyword research. Give exactly one of runId (one search with its rows: keyword, national volume, keyword difficulty 0 to 100, intent, CPC, trend, and the city's monthly volume and CPC when a city was chosen; status queued or running means it is still working) or workspaceId (the last 20 searches of that workspace, without rows). chargedUsd is null unless the role has geogrid:cost. Reads stored data only. Needs geogrid:read.",
  input: z.object({ runId: z.uuid().optional(), workspaceId: z.uuid().optional() }),
  output: z.object({ run: runOut.nullable(), rows: z.array(rowOut), history: z.array(runOut) }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (!!input.runId === !!input.workspaceId) throw new CoreError("INVALID_INPUT", "Give exactly one of runId or workspaceId");
    const showMoney = roleHasPermission(actor.role, "geogrid:cost");
    const shape = (r: Omit<typeof seoKeywordResearchRuns.$inferSelect, "rows"> & { rowCount: number }) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      locationId: r.locationId,
      seed: r.seed,
      countryIso: r.countryIso,
      city: r.cityLocationName,
      rowLimit: r.rowLimit,
      dataSource: r.dataSource,
      status: r.status,
      chargedUsd: showMoney ? Number(r.chargedUsd ?? 0) : null,
      localVolumeNote: r.localVolumeNote,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      rowCount: r.rowCount,
    });
    if (input.runId) {
      const [r] = await tx.select().from(seoKeywordResearchRuns).where(and(eq(seoKeywordResearchRuns.id, input.runId), eq(seoKeywordResearchRuns.orgId, actor.orgId)));
      if (!r) throw new AccessError("NOT_FOUND", "Search not found");
      authorize(actor, "geogrid:read", { workspaceId: r.workspaceId });
      const stored = (r.rows ?? []) as z.input<typeof rowOut>[];
      return { run: shape({ ...r, rowCount: stored.length }), rows: stored, history: [] };
    }
    await loadWorkspace(tx, actor, input.workspaceId!, "geogrid:read");
    const { rows: _omit, ...cols } = getTableColumns(seoKeywordResearchRuns);
    void _omit;
    const list = await tx
      .select({ ...cols, rowCount: sql<number>`jsonb_array_length(${seoKeywordResearchRuns.rows})` })
      .from(seoKeywordResearchRuns)
      .where(and(eq(seoKeywordResearchRuns.orgId, actor.orgId), eq(seoKeywordResearchRuns.workspaceId, input.workspaceId!)))
      .orderBy(desc(seoKeywordResearchRuns.createdAt))
      .limit(20);
    return { run: null, rows: [], history: list.map(shape) };
  },
});

export const seoCitiesSearch = defineAction({
  name: "seo.cities.search",
  description:
    "Find city names Google Ads can report monthly search volume for, in one country (IN, US, AU, GB, CA, NZ, AE): up to 10 matches for the typed text (at least 2 characters), each with the exact geotarget name used by keyword research and its type. Free. Needs geogrid:read.",
  input: z.object({ countryIso: z.enum(COUNTRIES), query: z.string().trim().max(80) }),
  output: z.object({ cities: z.array(z.object({ locationName: z.string(), locationType: z.string() })) }),
  permission: "geogrid:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db }, input) {
    return { cities: await searchCities(db, { countryIso: input.countryIso, query: input.query }) };
  },
});
