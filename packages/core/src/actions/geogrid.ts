import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  competitorProfiles,
  gridCompetitorSnapshots,
  gridConfigKinds,
  gridConfigs,
  gridDriverIds,
  gridPoints,
  gridRuns,
  gridCompetitorRefreshDefaults,
  gridSchedules,
  gridTasks,
  locationCenterSources,
  locations,
  orgGridSettings,
  workspaces,
  type Db,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { GEOGRID_DEFAULTS, GEOGRID_PRICING, GEOGRID_SPEEDS, taskPriceUsd, GRID_SPEEDS, type GridSpeed } from "../config/geogrid";
import { CoreError } from "../errors";
import { competitorTable, runSummary, type Competitor } from "../geogrid/analytics";
import { diffProfiles, weeklyRefreshEstimateUsd, type StoredProfile } from "../competitors/profiles";
import { diffCompetitorSnapshots, type SnapshotRow } from "../geogrid/competitor-snapshots";
import { notifyBudgetExceeded } from "../geogrid/budget-alert";
import {
  BudgetExceededError,
  estimateCostUsd,
  getGridBilling,
  monthToDateUsd,
  PlatformCapExceededError,
} from "../geogrid/cost";
import { hasByoKey } from "../geogrid/byo";
import { createLiveDriverRegistry, normalizeDomain, type DriverRegistry } from "../geogrid/drivers";
import { buildGrid } from "../geogrid/math";
import { pointCount, requestGridRuns } from "../geogrid/run";
import { nextScheduledRunAt } from "../geogrid/schedule";
import { defineAction } from "../registry";
import { clientForLocation, googleNames, loadLocation } from "../locationOps/access";
import { roleHasPermission } from "../permissions";

/** Used for labels, flags and cost estimates only; the worker owns the driver that does the work. */
let drivers: DriverRegistry = createLiveDriverRegistry();
/** Test seam: lets a test make the action layer see a live data source without any network. */
export function setGeogridDriversForTests(r: DriverRegistry | null) {
  drivers = r ?? createLiveDriverRegistry();
}

const driverEnum = z.enum(gridDriverIds);
const speedEnum = z.enum(GRID_SPEEDS);

/** Per-speed price and wait for one grid; DataForSEO sources only (the relevance check has one free speed). */
const speedEstimateOut = z.object({
  speed: speedEnum,
  perTaskUsd: z.number(),
  typicalMinutes: z.number(),
  /** What this speed would cost for the previewed grid, with the org's markup (or none on its own key). */
  estimateUsd: z.number(),
  wouldExceed: z.boolean(),
  priceSourceUrl: z.string(),
  priceVerifiedOn: z.string(),
});
const scheduleEnum = z.enum(gridSchedules);
const refreshDefaultEnum = z.enum(gridCompetitorRefreshDefaults);

type ConfigRow = typeof gridConfigs.$inferSelect;
type RunRow = typeof gridRuns.$inferSelect;

const driverInfo = (id: ConfigRow["driverId"]) => {
  const d = drivers(id);
  return { driverLabel: d.label, isMapsRank: d.isMapsRank };
};

const configOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.enum(gridConfigKinds),
  locationId: z.string().nullable(),
  keywords: z.array(z.string()),
  favoriteKeywords: z.array(z.string()),
  gridSize: z.number(),
  radiusM: z.number(),
  centerLat: z.number(),
  centerLng: z.number(),
  targetName: z.string(),
  targetPlaceId: z.string().nullable(),
  driverId: driverEnum,
  /** Always show this next to results from this driver. */
  driverLabel: z.string(),
  /** false = positions are NOT Google Maps rank. */
  isMapsRank: z.boolean(),
  schedule: scheduleEnum,
  active: z.boolean(),
  lastScheduledAt: z.string().nullable(),
  /** When the daily schedule job will next enqueue this tracker (UTC). Null for manual or inactive. */
  nextRunAt: z.string().nullable(),
  /** How often this tracker's top competitors' profiles (categories, photos, recent posts) are refreshed. "manual" = off. */
  competitorRefresh: scheduleEnum,
  competitorRefreshedAt: z.string().nullable(),
  /** Top competitors skipped at the last refresh because Google gave no place id. */
  competitorSkippedNoPlaceId: z.number(),
  /** What one refresh can cost the org (up to the top 10 competitors, incl. markup). Null unless the role has geogrid:cost. */
  competitorRefreshEstimateUsd: z.number().nullable(),
  pointCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Cost of one competitor refresh at the org's markup; null for roles without geogrid:cost. */
async function refreshEstimateFor(tx: Tx, actor: Actor): Promise<number | null> {
  return roleHasPermission(actor.role, "geogrid:cost") ? weeklyRefreshEstimateUsd((await getGridBilling(tx, actor.orgId)).markupPercent) : null;
}

const configToOut = (c: ConfigRow, refreshEstimateUsd: number | null): z.input<typeof configOut> => ({
  id: c.id,
  workspaceId: c.workspaceId,
  kind: c.kind,
  locationId: c.locationId,
  keywords: c.keywords,
  favoriteKeywords: c.favoriteKeywords,
  gridSize: c.gridSize,
  radiusM: c.radiusM,
  centerLat: c.centerLat,
  centerLng: c.centerLng,
  targetName: c.targetName,
  targetPlaceId: c.targetPlaceId,
  driverId: c.driverId,
  ...driverInfo(c.driverId),
  schedule: c.schedule,
  active: c.active,
  lastScheduledAt: c.lastScheduledAt ? c.lastScheduledAt.toISOString() : null,
  nextRunAt: c.active
    ? (nextScheduledRunAt(c.schedule, c.lastScheduledAt, new Date())?.toISOString() ?? null)
    : null,
  competitorRefresh: c.competitorRefresh,
  competitorRefreshedAt: c.competitorRefreshedAt ? c.competitorRefreshedAt.toISOString() : null,
  competitorSkippedNoPlaceId: c.competitorSkippedNoPlaceId,
  competitorRefreshEstimateUsd: refreshEstimateUsd,
  pointCount: pointCount(c),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const summaryOut = z.object({
  points: z.number(),
  averageRank: z.number().nullable(),
  top3Share: z.number().nullable(),
  foundShare: z.number().nullable(),
});

const runOut = z.object({
  id: z.string(),
  configId: z.string(),
  keyword: z.string(),
  driverId: driverEnum,
  driverLabel: z.string(),
  isMapsRank: z.boolean(),
  status: z.enum(["queued", "running", "done", "failed"]),
  /** null = hidden: the caller's role lacks geogrid:cost (client roles). */
  costEstimateUsd: z.number().nullable(),
  costChargedUsd: z.number().nullable(),
  /** Where this run's data came from. Only "live" is real Google Maps data; the others are sample data. */
  dataSource: z.enum(["fixture", "sandbox", "live"]),
  /** What DataForSEO reported charging for the run; null until submitted, or hidden without geogrid:cost. */
  providerCostUsd: z.number().nullable(),
  /** Queue speed this run was requested at. */
  speed: speedEnum,
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  summary: summaryOut,
});

const runToOut = (
  r: RunRow,
  points: readonly { rank: number | null }[],
  showCost: boolean,
): z.input<typeof runOut> => ({
  id: r.id,
  configId: r.configId,
  keyword: r.keyword,
  driverId: r.driverId,
  ...driverInfo(r.driverId),
  status: r.status,
  costEstimateUsd: showCost ? Number(r.costEstimateUsd) : null,
  costChargedUsd: showCost && r.costChargedUsd !== null ? Number(r.costChargedUsd) : null,
  dataSource: r.dataSource,
  speed: r.speed,
  providerCostUsd: showCost && r.providerCostUsd !== null ? Number(r.providerCostUsd) : null,
  error: r.error,
  startedAt: r.startedAt ? r.startedAt.toISOString() : null,
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  summary: runSummary(points),
});

async function loadConfig(tx: Tx, actor: Actor, id: string): Promise<ConfigRow> {
  const [c] = await tx
    .select()
    .from(gridConfigs)
    .where(and(eq(gridConfigs.id, id), eq(gridConfigs.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  if (!c || (scope !== "all" && !scope.includes(c.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Geo-grid configuration not found");
  }
  return c;
}

async function loadRun(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx
    .select()
    .from(gridRuns)
    .where(and(eq(gridRuns.id, id), eq(gridRuns.orgId, actor.orgId)));
  if (!r) throw new AccessError("NOT_FOUND", "Geo-grid run not found");
  const config = await loadConfig(tx, actor, r.configId);
  return { run: r, config };
}

const keywordsSchema = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(GEOGRID_DEFAULTS.maxKeywordsPerConfig);

type Shape = Pick<
  ConfigRow,
  "gridSize" | "radiusM" | "centerLat" | "centerLng" | "driverId" | "targetPlaceId" | "keywords"
>;

/** Cross-field rules; throws INVALID_INPUT. buildGrid checks size, radius and coordinates. */
function validateShape(s: Shape) {
  buildGrid({ lat: s.centerLat, lng: s.centerLng, size: s.gridSize, radiusM: s.radiusM });
  if (s.driverId === "places_relevance" && !s.targetPlaceId) {
    throw new CoreError(
      "INVALID_INPUT",
      "The relevance check needs the business's Google place id (targetPlaceId)",
    );
  }
  if (new Set(s.keywords.map((k) => k.toLowerCase())).size !== s.keywords.length) {
    throw new CoreError("INVALID_INPUT", "Keywords must be unique");
  }
}

const configFields = {
  keywords: keywordsSchema,
  gridSize: z.number().int(),
  radiusM: z.number().int(),
  centerLat: z.number(),
  centerLng: z.number(),
  targetName: z.string().trim().min(1).max(200),
  targetPlaceId: z.string().trim().min(1).max(300).nullable(),
  driverId: driverEnum,
  schedule: scheduleEnum,
  active: z.boolean(),
};

export const geogridConfigsList = defineAction({
  name: "geogrid.configs.list",
  description:
    "List geo-grid configurations the caller can see (a business, keywords, grid size and radius, data source, schedule). Optional filters: workspaceId, locationId. kind defaults to 'tracker'; pass 'quick_scan' for quick scans of businesses that are not managed locations (their locationId is null). Each config carries driverLabel and isMapsRank: the 'places_relevance' source is labelled 'Relevance check (not Maps rank)' and its positions are NOT Google Maps rank. Needs geogrid:read.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    kind: z.enum(gridConfigKinds).default("tracker"),
  }),
  output: z.object({ configs: z.array(configOut) }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "geogrid:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const rows = await tx
      .select()
      .from(gridConfigs)
      .where(
        and(
          eq(gridConfigs.orgId, actor.orgId),
          eq(gridConfigs.kind, input.kind),
          scope === "all" ? undefined : inArray(gridConfigs.workspaceId, scope),
          input.workspaceId ? eq(gridConfigs.workspaceId, input.workspaceId) : undefined,
          input.locationId ? eq(gridConfigs.locationId, input.locationId) : undefined,
        ),
      )
      .orderBy(asc(gridConfigs.createdAt), asc(gridConfigs.id));
    const estimate = await refreshEstimateFor(tx, actor);
    return { configs: rows.map((r) => configToOut(r, estimate)) };
  },
});

export const geogridLocationCenter = defineAction({
  name: "geogrid.locationCenter",
  description:
    "Where a new tracker for a location should be centred: centerLat, centerLng (null when there are no coordinates) and placeId (Google's place id, null when it cannot be read). The coordinates stored on the location when it was onboarded (and refreshed only when its address changed) come first; centerSource says which gave them ('google', 'places', 'dataforseo', 'tracker', 'manual' or null). Only when nothing is stored is the live Google profile read for coordinates, and then the centre and place id of the location's most recently updated rank tracker. note says why a value is missing or substituted (not linked to Google, no connection, Google could not be read, using the tracker's centre) so the caller can ask the person to type it. websiteDomain is the profile's website as a bare domain (null when none). Read only; does not change the location. Needs geogrid:manage (owner, admin, manager).",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    centerLat: z.number().nullable(),
    centerLng: z.number().nullable(),
    centerSource: z.enum(locationCenterSources).nullable(),
    placeId: z.string().nullable(),
    /** The profile's website as a bare domain (no scheme, no www), null when it has none. Keyword rank finds the business in organic results by it. */
    websiteDomain: z.string().nullable(),
    note: z.string().nullable(),
  }),
  permission: "geogrid:manage",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "geogrid:manage");
    type Out = {
      centerLat: number | null;
      centerLng: number | null;
      centerSource: (typeof locationCenterSources)[number] | null;
      placeId: string | null;
      websiteDomain: string | null;
      note: string | null;
    };
    /** Google gave no centre: use the location's most recently updated rank tracker, if it has one. */
    const withoutGoogleCentre = async (base: Out, why: string): Promise<Out> => {
      const [tracker] = await db
        .select({ lat: gridConfigs.centerLat, lng: gridConfigs.centerLng, placeId: gridConfigs.targetPlaceId })
        .from(gridConfigs)
        .where(and(eq(gridConfigs.orgId, actor.orgId), eq(gridConfigs.locationId, loc.id), eq(gridConfigs.kind, "tracker")))
        .orderBy(desc(gridConfigs.updatedAt), desc(gridConfigs.id))
        .limit(1);
      if (!tracker) return { ...base, note: why };
      return {
        ...base,
        centerLat: tracker.lat,
        centerLng: tracker.lng,
        centerSource: "tracker",
        placeId: base.placeId ?? tracker.placeId ?? null,
        note: `Using the centre of your rank tracker. ${why}`,
      };
    };
    const none: Out = { centerLat: null, centerLng: null, centerSource: null, placeId: null, websiteDomain: null, note: null };
    // The coordinates stored on the location win: they were resolved once and move only with the address.
    const stored = (base: Out): Out | null =>
      loc.centerLat != null && loc.centerLng != null && loc.centerSource
        ? { ...base, centerLat: loc.centerLat, centerLng: loc.centerLng, centerSource: loc.centerSource }
        : null;
    if (!loc.googleLocationId || !loc.googleAccountName) return stored(none) ?? withoutGoogleCentre(none, "This location is not linked to Google.");
    try {
      const client = await clientForLocation(db, actor, loc);
      const g = await client.getLocation(googleNames(loc).locationName, { readMask: "name,latlng,metadata,websiteUri" });
      const lat = g.latlng?.latitude;
      const lng = g.latlng?.longitude;
      const id = g.metadata?.placeId;
      const base: Out = { ...none, placeId: id && PLACE_ID.test(id) ? id : null, websiteDomain: normalizeDomain(g.websiteUri) };
      const kept = stored(base);
      if (kept) return kept;
      if (typeof lat === "number" && typeof lng === "number") return { ...base, centerLat: lat, centerLng: lng, centerSource: "google" as const };
      return withoutGoogleCentre(base, "Google has no coordinates for this location.");
    } catch {
      return stored(none) ?? withoutGoogleCentre(none, "Google could not be read for this location.");
    }
  },
});

export const geogridConfigsCreate = defineAction({
  name: "geogrid.configs.create",
  description:
    "Create a geo-grid configuration for a location. centerLat/centerLng are required; geogrid.locationCenter reads them (and the place id) from the location's Google profile. gridSize is odd, 3 to 13; radiusM is the distance from the centre to the edge (100 to 50000). targetName defaults to the location's title; targetPlaceId (Google place id) is required for driverId 'places_relevance', which is a relevance check, NOT Maps rank. driverId 'dataforseo_standard' is the Maps-rank source and costs money (see geogrid.preview). competitorRefresh (manual = off, weekly) is how often the top competitors' profiles are refreshed; leave it out to take the organization's default (geogrid.settings.get defaultCompetitorRefresh, off until an owner or admin sets it). Needs geogrid:manage (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    keywords: configFields.keywords,
    gridSize: configFields.gridSize,
    radiusM: configFields.radiusM,
    centerLat: configFields.centerLat,
    centerLng: configFields.centerLng,
    targetName: configFields.targetName.optional(),
    targetPlaceId: configFields.targetPlaceId.optional(),
    driverId: configFields.driverId.default("dataforseo_standard"),
    schedule: configFields.schedule.default("manual"),
    competitorRefresh: scheduleEnum.optional(),
  }),
  output: z.object({ config: configOut }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [loc] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.id, input.locationId), eq(locations.orgId, actor.orgId)));
    if (!loc) throw new AccessError("NOT_FOUND", "Location not found");
    authorize(actor, "geogrid:manage", { workspaceId: loc.workspaceId });
    if (loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is inactive");
    const values = {
      keywords: input.keywords,
      gridSize: input.gridSize,
      radiusM: input.radiusM,
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      driverId: input.driverId,
      targetPlaceId: input.targetPlaceId ?? null,
    };
    validateShape(values);
    const [row] = await tx
      .insert(gridConfigs)
      .values({
        ...values,
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        targetName: input.targetName ?? loc.title ?? loc.name,
        schedule: input.schedule,
        competitorRefresh: input.competitorRefresh ?? (await getGridBilling(tx, actor.orgId)).defaultCompetitorRefresh,
        createdBy: actor.userId,
      })
      .returning();
    await audit({
      action: "geogrid.config_created",
      entityType: "grid_config",
      entityId: row!.id,
      before: null,
      after: row,
    });
    return { config: configToOut(row!, await refreshEstimateFor(tx, actor)) };
  },
});

/**
 * Favourites in the keywords' own spelling, de-duplicated. A favourite the caller sent that is not a
 * keyword is INVALID_INPUT; stored favourites whose keyword was removed are dropped silently.
 */
function canonicalFavorites(keywords: string[], favorites: string[], strict: boolean): string[] {
  const byLower = new Map(keywords.map((k) => [k.toLowerCase(), k]));
  const out: string[] = [];
  for (const f of favorites) {
    const k = byLower.get(f.toLowerCase());
    if (!k) {
      if (strict) throw new CoreError("INVALID_INPUT", `"${f}" is not one of this tracker's keywords`);
      continue;
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export const geogridConfigsUpdate = defineAction({
  name: "geogrid.configs.update",
  description:
    "Change a geo-grid configuration (any of keywords, favoriteKeywords, gridSize, radiusM, centerLat, centerLng, targetName, targetPlaceId, driverId, schedule, active, competitorRefresh). competitorRefresh is how often the top competitors' profiles are refreshed (manual turns it off; a new tracker starts with the organization's default, off until chosen); on live data each run has a cost. favoriteKeywords is the full list of starred keywords (a subset of keywords, matched case-insensitively); removing a keyword drops its star. Past runs keep the settings they ran with. Schedules (daily, weekly, monthly) enqueue runs automatically and are subject to the org's monthly budget. Needs geogrid:manage.",
  input: z.object({
    id: z.uuid(),
    keywords: configFields.keywords.optional(),
    favoriteKeywords: z
      .array(z.string().trim().min(1).max(120))
      .max(GEOGRID_DEFAULTS.maxKeywordsPerConfig)
      .optional(),
    gridSize: configFields.gridSize.optional(),
    radiusM: configFields.radiusM.optional(),
    centerLat: configFields.centerLat.optional(),
    centerLng: configFields.centerLng.optional(),
    targetName: configFields.targetName.optional(),
    targetPlaceId: configFields.targetPlaceId.optional(),
    driverId: configFields.driverId.optional(),
    schedule: configFields.schedule.optional(),
    active: configFields.active.optional(),
    competitorRefresh: scheduleEnum.optional(),
  }),
  output: z.object({ config: configOut }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadConfig(tx, actor, input.id);
    authorize(actor, "geogrid:manage", { workspaceId: before.workspaceId });
    if (before.kind === "keyword_rank") {
      throw new CoreError("INVALID_INPUT", "A keyword tracker is changed with rankings.track, rankings.untrack and rankings.setFavorite");
    }
    if (before.kind === "quick_scan" && input.schedule !== undefined && input.schedule !== "manual") {
      throw new CoreError("INVALID_INPUT", "A quick scan runs only when someone runs it; it cannot be scheduled");
    }
    const { id: _id, ...patch } = input;
    void _id;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<ConfigRow>;
    const merged = { ...before, ...defined };
    validateShape(merged);
    defined.favoriteKeywords = canonicalFavorites(
      merged.keywords,
      input.favoriteKeywords ?? before.favoriteKeywords,
      input.favoriteKeywords !== undefined,
    );
    const [row] = await tx
      .update(gridConfigs)
      .set({ ...defined, updatedAt: new Date() })
      .where(eq(gridConfigs.id, before.id))
      .returning();
    await audit({
      action: "geogrid.config_updated",
      entityType: "grid_config",
      entityId: before.id,
      before,
      after: row,
    });
    return { config: configToOut(row!, await refreshEstimateFor(tx, actor)) };
  },
});

export const geogridConfigsDelete = defineAction({
  name: "geogrid.configs.delete",
  description:
    "Delete a geo-grid configuration together with its runs and results. Spend already charged still counts toward this month's budget only while the runs exist, so prefer setting active=false to keep history. Needs geogrid:manage.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadConfig(tx, actor, input.id);
    authorize(actor, "geogrid:manage", { workspaceId: before.workspaceId });
    await tx.delete(gridConfigs).where(eq(gridConfigs.id, before.id));
    await audit({
      action: "geogrid.config_deleted",
      entityType: "grid_config",
      entityId: before.id,
      before,
      after: null,
    });
    return { id: before.id };
  },
});

export const geogridPreview = defineAction({
  name: "geogrid.preview",
  description:
    "Cost preview before running (driverId 'dataforseo_serp' prices keyword rank checks: gridSize 1, one Google search per keyword, up to 25 keywords, two SERP pages each): estimate = points (gridSize squared) x keywordCount x the driver's per-task price x (1 + the org's markup). Pass speed ('standard' or 'fast', default the org's default speed) to price one speed; `speeds` always lists every speed side by side (standard: normal queue, about 5 min, $0.0006/task; fast: DataForSEO high priority, about 1 min, $0.0012/task). Returns the estimate, this UTC month's spend so far (queued and running runs count at their estimate), the monthly budget, what remains, and wouldExceed. The relevance check (places_relevance) is free and not Maps rank. Needs geogrid:cost (owner, admin, manager; hidden from client roles).",
  input: z.object({
    driverId: driverEnum,
    gridSize: z.number().int().min(1).max(13),
    keywordCount: z.number().int().min(1).max(GEOGRID_DEFAULTS.maxRankKeywords),
    speed: speedEnum.optional(),
  }),
  output: z.object({
    driverId: driverEnum,
    /** The speed `estimateUsd` and `perTaskUsd` are for. */
    speed: speedEnum,
    speeds: z.array(speedEstimateOut),
    driverLabel: z.string(),
    isMapsRank: z.boolean(),
    points: z.number(),
    keywordCount: z.number(),
    perTaskUsd: z.number(),
    markupPercent: z.number(),
    /** true = the org's own DataForSEO key is used: billed at cost (markup 0) and never blocked by the budget. */
    byoKey: z.boolean(),
    estimateUsd: z.number(),
    monthToDateUsd: z.number(),
    monthlyBudgetUsd: z.number(),
    remainingUsd: z.number(),
    wouldExceed: z.boolean(),
  }),
  permission: "geogrid:cost",
  kind: "read",
  async handler({ tx, actor }, input) {
    // Keyword rank (driverId 'dataforseo_serp') is one search per keyword: gridSize 1. Geo-grids are odd, 3 to 13, up to 5 keywords.
    const rank = input.driverId === "dataforseo_serp";
    if (rank ? input.gridSize !== 1 : input.gridSize < 3 || input.gridSize % 2 === 0) {
      throw new CoreError("INVALID_INPUT", rank ? "Keyword rank uses gridSize 1" : "Grid size must be odd, 3 to 13");
    }
    if (!rank && input.keywordCount > GEOGRID_DEFAULTS.maxKeywordsPerConfig) {
      throw new CoreError("INVALID_INPUT", `A geo-grid has up to ${GEOGRID_DEFAULTS.maxKeywordsPerConfig} keywords`);
    }
    const billing = await getGridBilling(tx, actor.orgId);
    const spent = await monthToDateUsd(tx, actor.orgId, new Date());
    const points = input.gridSize * input.gridSize;
    const byoKey = input.driverId !== "places_relevance" && (await hasByoKey(tx, actor.orgId));
    const markupPercent = byoKey ? 0 : billing.markupPercent;
    const speed = input.speed ?? billing.defaultSpeed;
    const remainingUsd = billing.monthlyBudgetUsd - spent;
    const estimateFor = (s: GridSpeed) =>
      estimateCostUsd({ driverId: input.driverId, points, keywordCount: input.keywordCount, markupPercent, speed: s });
    const estimateUsd = estimateFor(speed);
    // The relevance check has one free speed; the Maps-rank source offers every speed.
    const offered = input.driverId !== "places_relevance" ? GRID_SPEEDS : (["standard"] as const);
    return {
      driverId: input.driverId,
      speed,
      speeds: offered.map((s) => ({
        speed: s,
        perTaskUsd: taskPriceUsd(input.driverId, s),
        typicalMinutes: GEOGRID_SPEEDS[s].typicalMinutes,
        estimateUsd: estimateFor(s),
        wouldExceed: !byoKey && estimateFor(s) > remainingUsd + 1e-9,
        priceSourceUrl: GEOGRID_SPEEDS[s].sourceUrl,
        priceVerifiedOn: GEOGRID_SPEEDS[s].verifiedOn,
      })),
      ...driverInfo(input.driverId),
      points,
      keywordCount: input.keywordCount,
      perTaskUsd: taskPriceUsd(input.driverId, speed),
      markupPercent,
      byoKey,
      estimateUsd,
      monthToDateUsd: spent,
      monthlyBudgetUsd: billing.monthlyBudgetUsd,
      remainingUsd,
      wouldExceed: !byoKey && estimateUsd > remainingUsd + 1e-9,
    };
  },
});

export const geogridRun = defineAction({
  name: "geogrid.run",
  description:
    "Run a geo-grid now: queues one run per keyword of the configuration (results arrive asynchronously; poll geogrid.runs.get). Fails with FORBIDDEN 'BUDGET_EXCEEDED' if the total estimate does not fit in the org's remaining monthly budget, or 'PLATFORM_CAP_EXCEEDED' when the service-wide daily DataForSEO limit is used up (the org's owners and admins are notified either way); call geogrid.preview first. Optional speed ('standard' or 'fast', default the org's default speed) picks the DataForSEO queue: fast is high priority, about 1 min, twice the price. Needs geogrid:manage.",
  input: z.object({ configId: z.uuid(), speed: speedEnum.optional() }),
  output: z.object({
    runs: z.array(
      z.object({ runId: z.string(), keyword: z.string(), costEstimateUsd: z.number() }),
    ),
  }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, db, actor, audit }, input) {
    const config = await loadConfig(tx, actor, input.configId);
    authorize(actor, "geogrid:manage", { workspaceId: config.workspaceId });
    if (!config.active) throw new CoreError("INVALID_INPUT", "Configuration is not active");
    const runs = await requestWithAlert(db, tx, { config, requestedBy: actor.userId, audit, speed: input.speed });
    return { runs };
  },
});

/**
 * requestGridRuns, plus the owner alert on a refusal. The action's transaction rolls back on the
 * thrown error, so the notification is written in its own transaction before the error goes on.
 */
async function requestWithAlert(
  db: Db,
  tx: Tx,
  p: { config: ConfigRow; requestedBy: string | null; audit: Parameters<typeof requestGridRuns>[1]["audit"]; speed?: GridSpeed },
) {
  try {
    return await requestGridRuns(tx, { ...p, drivers });
  } catch (e) {
    if (e instanceof BudgetExceededError || e instanceof PlatformCapExceededError) {
      const scope = e instanceof PlatformCapExceededError ? "platform" : "org";
      await db.transaction((t) => notifyBudgetExceeded(t, { orgId: p.config.orgId, scope, audit: false }));
    }
    throw e;
  }
}

/** Google place ids are URL-safe base64-like strings; without the Places API only the shape can be checked. */
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

export const geogridQuickScansCreate = defineAction({
  name: "geogrid.quickScans.create",
  description:
    "Quick scan of any business (for example a prospect) that is not a managed location: one keyword over a grid around centerLat/centerLng, matched by its Google place id (placeId, required; business search is not available on this server, so the id is pasted). Creates a quick-scan configuration (kind 'quick_scan', no location, schedule manual) in workspaceId and queues its first run in the same step; uses the same budget, prices and own-key rules as trackers and fails with FORBIDDEN 'BUDGET_EXCEEDED' (nothing created) when the estimate does not fit (see geogrid.preview). Re-run with geogrid.run, read with geogrid.runs.list kind 'quick_scan' and geogrid.runs.get, remove with geogrid.configs.delete. Needs geogrid:manage (owner, admin, manager).",
  input: z.object({
    workspaceId: z.uuid(),
    businessName: z.string().trim().min(1).max(200),
    placeId: z.string().trim().min(1).max(300),
    keyword: z.string().trim().min(1).max(120),
    /** Optional queue speed ('standard' or 'fast'); defaults to the org's default speed. */
    speed: speedEnum.optional(),
    gridSize: z.number().int(),
    radiusM: z.number().int(),
    centerLat: z.number(),
    centerLng: z.number(),
  }),
  output: z.object({
    scan: configOut,
    runs: z.array(z.object({ runId: z.string(), keyword: z.string(), costEstimateUsd: z.number() })),
  }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, db, actor, audit }, input) {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
    authorize(actor, "geogrid:manage", { workspaceId: ws.id });
    if (!PLACE_ID.test(input.placeId)) {
      throw new CoreError("INVALID_INPUT", "That does not look like a Google place id");
    }
    validateShape({
      gridSize: input.gridSize,
      radiusM: input.radiusM,
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      driverId: "dataforseo_standard",
      targetPlaceId: input.placeId,
      keywords: [input.keyword],
    });
    const [row] = await tx
      .insert(gridConfigs)
      .values({
        orgId: actor.orgId,
        workspaceId: ws.id,
        kind: "quick_scan",
        locationId: null,
        keywords: [input.keyword],
        gridSize: input.gridSize,
        radiusM: input.radiusM,
        centerLat: input.centerLat,
        centerLng: input.centerLng,
        targetName: input.businessName,
        targetPlaceId: input.placeId,
        driverId: "dataforseo_standard",
        schedule: "manual",
        createdBy: actor.userId,
      })
      .returning();
    await audit({
      action: "geogrid.quick_scan_created",
      entityType: "grid_config",
      entityId: row!.id,
      before: null,
      after: row,
    });
    // Throws BudgetExceededError before writing a run; the transaction then drops the config too.
    const runs = await requestWithAlert(db, tx, { config: row!, requestedBy: actor.userId, audit, speed: input.speed });
    return { scan: configToOut(row!, await refreshEstimateFor(tx, actor)), runs };
  },
});

export const geogridRunsList = defineAction({
  name: "geogrid.runs.list",
  description:
    "List geo-grid runs, newest first, each with average rank (not found counts as 21), top-3 share and found share. Use it as history: filter by configId to see one configuration over time. limit defaults to 50 (max 200). Runs from the relevance check carry isMapsRank=false. kind (default 'tracker') picks trackers or quick scans. costEstimateUsd, costChargedUsd and providerCostUsd are null unless the role has geogrid:cost. dataSource is fixture, sandbox or live: only live runs are real Google Maps data. Needs geogrid:read.",
  input: z.object({
    configId: z.uuid().optional(),
    workspaceId: z.uuid().optional(),
    kind: z.enum(gridConfigKinds).default("tracker"),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ runs: z.array(runOut) }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "geogrid:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const rows = await tx
      .select({ run: gridRuns })
      .from(gridRuns)
      .innerJoin(gridConfigs, eq(gridConfigs.id, gridRuns.configId))
      .where(
        and(
          eq(gridRuns.orgId, actor.orgId),
          eq(gridConfigs.kind, input.kind),
          scope === "all" ? undefined : inArray(gridConfigs.workspaceId, scope),
          input.workspaceId ? eq(gridConfigs.workspaceId, input.workspaceId) : undefined,
          input.configId ? eq(gridRuns.configId, input.configId) : undefined,
        ),
      )
      .orderBy(desc(gridRuns.createdAt), desc(gridRuns.id))
      .limit(input.limit);
    const ids = rows.map((r) => r.run.id);
    const pts = ids.length
      ? await tx
          .select({ runId: gridPoints.runId, rank: gridPoints.rank })
          .from(gridPoints)
          .where(inArray(gridPoints.runId, ids))
      : [];
    return {
      runs: rows.map(({ run }) =>
        runToOut(
          run,
          pts.filter((p) => p.runId === run.id),
          roleHasPermission(actor.role, "geogrid:cost"),
        ),
      ),
    };
  },
});

const pointOut = z.object({
  row: z.number(),
  col: z.number(),
  lat: z.number(),
  lng: z.number(),
  rank: z.number().nullable(),
  top3: z.boolean(),
  competitors: z.array(
    z.object({
      rank: z.number(),
      title: z.string().nullable(),
      placeId: z.string().nullable(),
      rating: z.number().nullable(),
      isTarget: z.boolean(),
      address: z.string().nullable().optional(),
      reviewCount: z.number().nullable().optional(),
    }),
  ),
  /** true = not collected yet (the run is queued or running and this point's task has not settled). */
  pending: z.boolean(),
});

export const geogridRunsGet = defineAction({
  name: "geogrid.runs.get",
  description:
    "One geo-grid run with every point (row 0 is north, col 0 is west; rank null = not found in the top 20 or not collected yet) and its analytics: average rank (not found counts as 21), top-3 share, found share. Each point has pending (not collected yet); before the worker starts, points are the planned grid, all pending. progress counts collected points. If isMapsRank is false the numbers are a relevance check, NOT Google Maps rank, and must be presented as such. The run's cost fields are null unless the role has geogrid:cost. Needs geogrid:read.",
  input: z.object({ runId: z.uuid() }),
  output: z.object({
    run: runOut,
    gridSize: z.number(),
    points: z.array(pointOut),
    progress: z.object({ collected: z.number(), total: z.number() }),
    notice: z.string().nullable(),
  }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const { run, config } = await loadRun(tx, actor, input.runId);
    const pts = await tx
      .select()
      .from(gridPoints)
      .where(eq(gridPoints.runId, run.id))
      .orderBy(asc(gridPoints.row), asc(gridPoints.col));
    const tasks = await tx
      .select({ row: gridTasks.row, col: gridTasks.col, status: gridTasks.status })
      .from(gridTasks)
      .where(eq(gridTasks.runId, run.id));
    const open = run.status === "queued" || run.status === "running";
    const settled = new Set(
      tasks.filter((t) => t.status === "done" || t.status === "failed").map((t) => `${t.row}:${t.col}`),
    );
    const stored = pts.map((p) => ({
      row: p.row,
      col: p.col,
      lat: p.lat,
      lng: p.lng,
      rank: p.rank,
      top3: p.top3,
      competitors: p.competitors as Competitor[],
      pending: open && !settled.has(`${p.row}:${p.col}`),
    }));
    // A queued run has no points yet (the worker inserts them): show the planned grid, all pending.
    const points =
      stored.length > 0 || !open
        ? stored
        : config.kind === "keyword_rank"
          ? [{ row: 0, col: 0, lat: config.centerLat, lng: config.centerLng, rank: null, top3: false, competitors: [], pending: true }]
          : buildGrid({
            lat: config.centerLat,
            lng: config.centerLng,
            size: config.gridSize,
            radiusM: config.radiusM,
          }).map((g) => ({ ...g, rank: null, top3: false, competitors: [], pending: true }));
    const info = driverInfo(run.driverId);
    return {
      run: runToOut(run, pts, roleHasPermission(actor.role, "geogrid:cost")),
      gridSize: config.gridSize,
      points,
      progress: { collected: points.filter((p) => !p.pending).length, total: points.length },
      notice: info.isMapsRank ? null : `${info.driverLabel}: positions are NOT Google Maps rank.`,
    };
  },
});

export const geogridCompetitors = defineAction({
  name: "geogrid.competitors",
  description:
    "Competitor table for a run: every business seen at the grid points with appearances, average rank among those appearances, best rank, address, rating and Google review count (address and review count are null for runs stored before they were collected), most frequent first. Give runId, or configId for that configuration's latest finished run. includeTarget=true adds the tracked business itself as the first row (isTarget). Relevance-check runs list place ids only (no business names). Needs geogrid:read.",
  input: z
    .object({
      runId: z.uuid().optional(),
      configId: z.uuid().optional(),
      includeTarget: z.boolean().default(false),
    })
    .refine((v) => Boolean(v.runId) !== Boolean(v.configId), {
      message: "Pass exactly one of runId or configId",
    }),
  output: z.object({
    runId: z.string().nullable(),
    driverLabel: z.string().nullable(),
    isMapsRank: z.boolean().nullable(),
    competitors: z.array(
      z.object({
        business: z.string(),
        placeId: z.string().nullable(),
        appearances: z.number(),
        averageRank: z.number(),
        bestRank: z.number(),
        address: z.string().nullable(),
        rating: z.number().nullable(),
        reviewCount: z.number().nullable(),
        isTarget: z.boolean(),
      }),
    ),
  }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    let run: RunRow | undefined;
    if (input.runId) {
      run = (await loadRun(tx, actor, input.runId)).run;
    } else {
      const config = await loadConfig(tx, actor, input.configId!);
      [run] = await tx
        .select()
        .from(gridRuns)
        .where(and(eq(gridRuns.configId, config.id), eq(gridRuns.status, "done")))
        .orderBy(desc(gridRuns.finishedAt))
        .limit(1);
    }
    if (!run) return { runId: null, driverLabel: null, isMapsRank: null, competitors: [] };
    const pts = await tx.select().from(gridPoints).where(eq(gridPoints.runId, run.id));
    return {
      runId: run.id,
      ...driverInfo(run.driverId),
      competitors: competitorTable(
        pts.map((p) => ({ competitors: p.competitors as Competitor[] })),
        { includeTarget: input.includeTarget },
      ),
    };
  },
});

const changeOut = z.object({
  placeId: z.string(),
  title: z.string(),
  address: z.string().nullable(),
  appearances: z.number(),
  averageRank: z.number(),
  bestRank: z.number(),
  rating: z.number().nullable(),
  reviewCount: z.number().nullable(),
  status: z.enum(["new", "dropped", "continuing"]),
  rankChange: z.number().nullable(),
  reviewsAdded: z.number().nullable(),
  ratingChange: z.number().nullable(),
});

export const geogridCompetitorChanges = defineAction({
  name: "geogrid.competitors.changes",
  description:
    "Competitor changes for a geo-grid tracker: per keyword, the competitors seen in the latest finished run (one snapshot per day) and how each moved since the previous snapshot: average-rank change (positive = moved up), reviews added (review velocity), rating change, and which businesses are new or dropped out. previousDate is null until a second day of the same data source (fixture, sandbox or live) has been stored; then nothing is marked new. Sample data is never compared with live data. Reads stored run data only, so it costs nothing. Give keyword to look at one keyword. Needs geogrid:read.",
  input: z.object({ configId: z.uuid(), keyword: z.string().trim().min(1).max(120).optional() }),
  output: z.object({
    configId: z.string(),
    keywords: z.array(
      z.object({
        keyword: z.string(),
        currentDate: z.string(),
        previousDate: z.string().nullable(),
        /** Where the latest snapshot's data came from; changes compare only snapshots of this source. */
        dataSource: z.enum(["fixture", "sandbox", "live"]),
        competitors: z.array(changeOut),
      }),
    ),
  }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const config = await loadConfig(tx, actor, input.configId);
    const days = await tx
      .selectDistinct({
        keyword: gridCompetitorSnapshots.keyword,
        day: gridCompetitorSnapshots.snapshotDate,
        source: gridCompetitorSnapshots.dataSource,
      })
      .from(gridCompetitorSnapshots)
      .where(
        and(
          eq(gridCompetitorSnapshots.configId, config.id),
          eq(gridCompetitorSnapshots.orgId, actor.orgId),
          ...(input.keyword ? [eq(gridCompetitorSnapshots.keyword, input.keyword)] : []),
        ),
      )
      .orderBy(desc(gridCompetitorSnapshots.snapshotDate));
    // Newest day first; on a day with two sources the real one (live, then sandbox) wins.
    const sourceOrder = { live: 0, sandbox: 1, fixture: 2 } as const;
    days.sort((x, y) => (x.day === y.day ? sourceOrder[x.source] - sourceOrder[y.source] : x.day < y.day ? 1 : -1));
    // Per keyword: the latest snapshot, and the newest earlier day of the SAME data source (fixture is never compared with live).
    const wanted = new Map<string, { source: (typeof days)[number]["source"]; current: string; previous: string | null }>();
    for (const d of days) {
      const w = wanted.get(d.keyword);
      if (!w) wanted.set(d.keyword, { source: d.source, current: d.day, previous: null });
      else if (!w.previous && d.source === w.source && d.day !== w.current) w.previous = d.day;
    }
    if (wanted.size === 0) return { configId: config.id, keywords: [] };
    const rows = await tx
      .select()
      .from(gridCompetitorSnapshots)
      .where(
        and(
          eq(gridCompetitorSnapshots.configId, config.id),
          eq(gridCompetitorSnapshots.orgId, actor.orgId),
          or(
            ...[...wanted].map(([keyword, w]) =>
              and(
                eq(gridCompetitorSnapshots.keyword, keyword),
                eq(gridCompetitorSnapshots.dataSource, w.source),
                inArray(gridCompetitorSnapshots.snapshotDate, w.previous ? [w.current, w.previous] : [w.current]),
              ),
            ),
          ),
        ),
      );
    const toRow = (r: (typeof rows)[number]): SnapshotRow => ({
      placeId: r.placeId,
      title: r.title,
      address: r.address,
      appearances: r.appearances,
      averageRank: Number(r.avgRank),
      bestRank: r.bestRank,
      rating: r.rating === null ? null : Number(r.rating),
      reviewCount: r.reviewCount,
      dataSource: r.dataSource,
    });
    return {
      configId: config.id,
      keywords: [...wanted]
        .map(([keyword, w]) => ({
          keyword,
          currentDate: w.current,
          previousDate: w.previous,
          dataSource: w.source,
          competitors: diffCompetitorSnapshots(
            rows.filter((r) => r.keyword === keyword && r.snapshotDate === w.current).map(toRow),
            w.previous ? rows.filter((r) => r.keyword === keyword && r.snapshotDate === w.previous).map(toRow) : null,
          ),
        }))
        .sort((x, y) => x.keyword.localeCompare(y.keyword)),
    };
  },
});

const profileOut = z.object({
  placeId: z.string(),
  title: z.string().nullable(),
  /** UTC day this profile was fetched. */
  fetchedOn: z.string(),
  /** UTC day of the profile it is compared with; null until a second day of the same data source is stored. */
  previousDate: z.string().nullable(),
  primaryCategory: z.string().nullable(),
  additionalCategories: z.array(z.string()),
  totalPhotos: z.number().nullable(),
  /** The newest of the most recent updates (posts) returned; null = none found. */
  lastPostAt: z.string().nullable(),
  /** How many of the most recent updates were returned, capped at 10. Not a lifetime total. */
  recentPostsCount: z.number().nullable(),
  rating: z.number().nullable(),
  reviewCount: z.number().nullable(),
  change: z
    .object({
      photosAdded: z.number().nullable(),
      reviewsAdded: z.number().nullable(),
      ratingChange: z.number().nullable(),
      categoriesAdded: z.array(z.string()),
      categoriesRemoved: z.array(z.string()),
      postedSince: z.boolean(),
    })
    .nullable(),
});

export const geogridCompetitorProfiles = defineAction({
  name: "geogrid.competitors.profiles",
  description:
    "Profiles of a geo-grid tracker's top competitors (up to 10 by appearances), refreshed on their own schedule (the tracker's competitorRefresh, off unless chosen): primary and additional Google categories, photo count, rating and review count, the newest of their 10 most recent posts and how many came back (recentPostsCount, capped at 10, not a lifetime total), and what changed since the previous refresh (photos added, categories added or removed, new post). dataSource is fixture, sandbox or live and changes are only computed between profiles of the same source. refresh tells when the last refresh ran and how many top competitors were skipped for having no Google place id; estimatedRefreshUsd (the most one refresh can cost, markup included) is null unless the role has geogrid:cost. Reads stored data only. Needs geogrid:read.",
  input: z.object({ configId: z.uuid() }),
  output: z.object({
    configId: z.string(),
    dataSource: z.enum(["fixture", "sandbox", "live"]).nullable(),
    refresh: z.object({
      schedule: scheduleEnum,
      refreshedAt: z.string().nullable(),
      skippedNoPlaceId: z.number(),
      estimatedRefreshUsd: z.number().nullable(),
    }),
    profiles: z.array(profileOut),
  }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const config = await loadConfig(tx, actor, input.configId);
    const refresh = {
      schedule: config.competitorRefresh,
      refreshedAt: config.competitorRefreshedAt ? config.competitorRefreshedAt.toISOString() : null,
      skippedNoPlaceId: config.competitorSkippedNoPlaceId,
      estimatedRefreshUsd: await refreshEstimateFor(tx, actor),
    };
    const snaps = await tx
      .select({ placeId: gridCompetitorSnapshots.placeId, day: gridCompetitorSnapshots.snapshotDate, source: gridCompetitorSnapshots.dataSource })
      .from(gridCompetitorSnapshots)
      .where(and(eq(gridCompetitorSnapshots.configId, config.id), eq(gridCompetitorSnapshots.orgId, actor.orgId)))
      .orderBy(desc(gridCompetitorSnapshots.snapshotDate));
    if (snaps.length === 0) return { configId: config.id, dataSource: null, refresh, profiles: [] };
    // The source of the newest scan day (live first on a tie): profiles of other sources are never shown or compared.
    const order = { live: 0, sandbox: 1, fixture: 2 } as const;
    const dataSource = snaps.filter((s) => s.day === snaps[0]!.day).map((s) => s.source).sort((a, b) => order[a] - order[b])[0]!;
    const places = [...new Set(snaps.filter((s) => s.source === dataSource).map((s) => s.placeId))];
    const rows = await tx
      .select()
      .from(competitorProfiles)
      .where(and(eq(competitorProfiles.orgId, actor.orgId), eq(competitorProfiles.dataSource, dataSource), inArray(competitorProfiles.placeId, places)))
      .orderBy(desc(competitorProfiles.fetchedOn));
    const stored = (r: (typeof rows)[number]): StoredProfile => ({
      categories: r.categories,
      totalPhotos: r.totalPhotos,
      rating: r.rating === null ? null : Number(r.rating),
      reviewCount: r.reviewCount,
      lastPostAt: r.lastPostAt,
      postsCount: r.postsCount,
    });
    const byPlace = new Map<string, typeof rows>();
    for (const r of rows) byPlace.set(r.placeId, [...(byPlace.get(r.placeId) ?? []), r]);
    const profiles = [...byPlace.values()]
      .filter((list) => list[0]!.categories.primary)
      .map((list) => {
        const [cur, prev] = [list[0]!, list.find((r, i) => i > 0 && r.categories.primary)];
        return {
          placeId: cur.placeId,
          title: cur.title,
          fetchedOn: cur.fetchedOn,
          previousDate: prev?.fetchedOn ?? null,
          primaryCategory: cur.categories.primary,
          additionalCategories: cur.categories.additional,
          totalPhotos: cur.totalPhotos,
          lastPostAt: cur.lastPostAt ? cur.lastPostAt.toISOString() : null,
          recentPostsCount: cur.postsCount,
          rating: cur.rating === null ? null : Number(cur.rating),
          reviewCount: cur.reviewCount,
          change: prev ? diffProfiles(stored(cur), stored(prev)) : null,
        };
      })
      .sort((a, b) => (a.title ?? a.placeId).localeCompare(b.title ?? b.placeId));
    return { configId: config.id, dataSource, refresh, profiles };
  },
});

const settingsOut = z.object({
  monthlyBudgetUsd: z.number(),
  markupPercent: z.number(),
  /** Speed for scheduled runs, and the pre-selected speed on manual runs. */
  defaultSpeed: speedEnum,
  /** The competitor refresh a new tracker starts with ('manual' = off). Existing trackers keep their own choice. */
  defaultCompetitorRefresh: refreshDefaultEnum,
  /** The most one weekly competitor refresh costs a tracker, markup included. */
  weeklyRefreshEstimateUsd: z.number(),
  speeds: z.array(
    z.object({
      speed: speedEnum,
      perTaskUsd: z.number(),
      typicalMinutes: z.number(),
      priceSourceUrl: z.string(),
      priceVerifiedOn: z.string(),
      priceStatus: z.enum(["verified", "unverified"]),
    }),
  ),
  isDefault: z.boolean(),
  monthToDateUsd: z.number(),
  drivers: z.array(
    z.object({
      id: driverEnum,
      label: z.string(),
      isMapsRank: z.boolean(),
      perTaskUsd: z.number(),
      priceSourceUrl: z.string(),
      priceVerifiedOn: z.string(),
      priceStatus: z.enum(["verified", "unverified"]),
    }),
  ),
});

async function readSettings(tx: Tx, actor: Actor): Promise<z.input<typeof settingsOut>> {
  const b = await getGridBilling(tx, actor.orgId);
  return {
    monthlyBudgetUsd: b.monthlyBudgetUsd,
    markupPercent: b.markupPercent,
    defaultSpeed: b.defaultSpeed,
    defaultCompetitorRefresh: b.defaultCompetitorRefresh,
    weeklyRefreshEstimateUsd: weeklyRefreshEstimateUsd(b.markupPercent),
    speeds: GRID_SPEEDS.map((s) => ({
      speed: s,
      perTaskUsd: GEOGRID_SPEEDS[s].perTaskUsd,
      typicalMinutes: GEOGRID_SPEEDS[s].typicalMinutes,
      priceSourceUrl: GEOGRID_SPEEDS[s].sourceUrl,
      priceVerifiedOn: GEOGRID_SPEEDS[s].verifiedOn,
      priceStatus: GEOGRID_SPEEDS[s].status,
    })),
    isDefault: b.isDefault,
    monthToDateUsd: await monthToDateUsd(tx, actor.orgId, new Date()),
    // The keyword-rank source (K4) is not a choice on a geo-grid tracker.
    drivers: gridDriverIds.filter((id) => id !== "dataforseo_serp").map((id) => ({
      id,
      label: drivers(id).label,
      isMapsRank: drivers(id).isMapsRank,
      perTaskUsd: GEOGRID_PRICING[id].perTaskUsd,
      priceSourceUrl: GEOGRID_PRICING[id].sourceUrl,
      priceVerifiedOn: GEOGRID_PRICING[id].verifiedOn,
      priceStatus: GEOGRID_PRICING[id].status,
    })),
  };
}

export const geogridSettingsGet = defineAction({
  name: "geogrid.settings.get",
  description:
    "The organization's geo-grid billing settings: monthly budget (USD), markup percent on the data-source price, this month's spend, and the available data sources with their per-task price and its source. Defaults apply until an owner or admin changes them. Needs geogrid:cost (owner, admin, manager; hidden from client roles).",
  input: z.object({}),
  output: settingsOut,
  permission: "geogrid:cost",
  kind: "read",
  async handler({ tx, actor }) {
    return readSettings(tx, actor);
  },
});

export const geogridSettingsUpdate = defineAction({
  name: "geogrid.settings.update",
  description:
    "Set the organization's monthly geo-grid budget (USD), markup percent and/or defaultSpeed ('standard' or 'fast'; used by scheduled runs and pre-selected on manual runs) and/or defaultCompetitorRefresh ('manual' = off, or 'weekly'; the competitor refresh a NEW tracker starts with; it never changes existing trackers). Needs google:manage (owner, admin): the same org-level billing-style gate as Google connections, chosen over a new permission to keep the matrix small.",
  input: z.object({
    monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
    markupPercent: z.number().min(0).max(1000).optional(),
    defaultSpeed: speedEnum.optional(),
    defaultCompetitorRefresh: refreshDefaultEnum.optional(),
  }),
  output: settingsOut,
  permission: "google:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await getGridBilling(tx, actor.orgId);
    const next = {
      monthlyBudgetUsd: input.monthlyBudgetUsd ?? before.monthlyBudgetUsd,
      markupPercent: input.markupPercent ?? before.markupPercent,
      defaultSpeed: input.defaultSpeed ?? before.defaultSpeed,
      defaultCompetitorRefresh: input.defaultCompetitorRefresh ?? before.defaultCompetitorRefresh,
    };
    await tx
      .insert(orgGridSettings)
      .values({
        orgId: actor.orgId,
        monthlyBudgetUsd: next.monthlyBudgetUsd.toFixed(2),
        markupPercent: next.markupPercent.toFixed(2),
        defaultSpeed: next.defaultSpeed,
        defaultCompetitorRefresh: next.defaultCompetitorRefresh,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: orgGridSettings.orgId,
        set: {
          monthlyBudgetUsd: next.monthlyBudgetUsd.toFixed(2),
          markupPercent: next.markupPercent.toFixed(2),
          defaultSpeed: next.defaultSpeed,
          defaultCompetitorRefresh: next.defaultCompetitorRefresh,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        },
      });
    await audit({
      action: "geogrid.settings_updated",
      entityType: "org_grid_settings",
      entityId: actor.orgId,
      before: { monthlyBudgetUsd: before.monthlyBudgetUsd, markupPercent: before.markupPercent, defaultSpeed: before.defaultSpeed, defaultCompetitorRefresh: before.defaultCompetitorRefresh },
      after: next,
    });
    return readSettings(tx, actor);
  },
});
