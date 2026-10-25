import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { gridConfigs, gridPoints, gridRuns, gridSchedules, locations, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { GEOGRID_DEFAULTS } from "../config/geogrid";
import { CoreError } from "../errors";
import { normalizeDomain } from "../geogrid/drivers";
import { nextScheduledRunAt } from "../geogrid/schedule";
import { defineAction } from "../registry";

// K4 keyword rank tracking. A tracker is a grid_configs row of kind "keyword_rank" (one per location, grid size 1);
// its runs, budget, credit debit, pingback and daily schedule are the K1 geo-grid machinery.

type ConfigRow = typeof gridConfigs.$inferSelect;

async function loadRankConfig(tx: Tx, actor: Actor, id: string): Promise<ConfigRow> {
  const [c] = await tx
    .select()
    .from(gridConfigs)
    .where(and(eq(gridConfigs.id, id), eq(gridConfigs.orgId, actor.orgId), eq(gridConfigs.kind, "keyword_rank")));
  const scope = workspaceScope(actor);
  if (!c || (scope !== "all" && !scope.includes(c.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Keyword tracker not found");
  }
  return c;
}

const lc = (s: string) => s.toLowerCase();

export const rankingsTrack = defineAction({
  name: "rankings.track",
  description:
    "Track a search keyword for a location: how the business ranks for it on Google, in the local pack and in the organic results, checked on a schedule (default daily; each check costs a little, see geogrid.preview with driverId 'dataforseo_serp'). Adds the keyword to the location's keyword tracker, creating the tracker the first time (centerLat and centerLng are then required: geogrid.locationCenter reads them from the Google profile; targetDomain is the business's website, used to find it in the organic results). Tracking a keyword that is already tracked changes nothing. Needs geogrid:manage (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    keyword: z.string().trim().min(1).max(120),
    centerLat: z.number().optional(),
    centerLng: z.number().optional(),
    targetPlaceId: z.string().trim().min(1).max(300).nullable().optional(),
    targetDomain: z.string().trim().min(1).max(300).nullable().optional(),
    schedule: z.enum(gridSchedules).default("daily"),
  }),
  output: z.object({
    configId: z.string(),
    keyword: z.string(),
    /** true = this call created the location's tracker. */
    trackerCreated: z.boolean(),
    /** false = the keyword was already tracked. */
    keywordAdded: z.boolean(),
  }),
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
    const domain = normalizeDomain(input.targetDomain);
    const [existing] = await tx
      .select()
      .from(gridConfigs)
      .where(
        and(
          eq(gridConfigs.orgId, actor.orgId),
          eq(gridConfigs.kind, "keyword_rank"),
          eq(gridConfigs.locationId, loc.id),
        ),
      )
      .for("update");
    if (existing) {
      if (existing.keywords.some((k) => lc(k) === lc(input.keyword))) {
        await audit({
          action: "rankings.keyword_already_tracked",
          entityType: "grid_config",
          entityId: existing.id,
          before: null,
          after: { keyword: input.keyword },
        });
        return { configId: existing.id, keyword: input.keyword, trackerCreated: false, keywordAdded: false };
      }
      if (existing.keywords.length >= GEOGRID_DEFAULTS.maxRankKeywords) {
        throw new CoreError(
          "INVALID_INPUT",
          `A location can track up to ${GEOGRID_DEFAULTS.maxRankKeywords} keywords; remove one first`,
        );
      }
      const [row] = await tx
        .update(gridConfigs)
        .set({
          keywords: [...existing.keywords, input.keyword],
          targetDomain: existing.targetDomain ?? domain,
          updatedAt: new Date(),
        })
        .where(eq(gridConfigs.id, existing.id))
        .returning();
      await audit({
        action: "rankings.keyword_tracked",
        entityType: "grid_config",
        entityId: existing.id,
        before: existing,
        after: row,
      });
      return { configId: existing.id, keyword: input.keyword, trackerCreated: false, keywordAdded: true };
    }
    if (input.centerLat === undefined || input.centerLng === undefined) {
      throw new CoreError(
        "INVALID_INPUT",
        "centerLat and centerLng are required to start tracking keywords for this location (geogrid.locationCenter reads them)",
      );
    }
    if (!(Math.abs(input.centerLat) <= 85) || !(Math.abs(input.centerLng) <= 180)) {
      throw new CoreError("INVALID_INPUT", "Latitude must be within +/-85 and longitude +/-180");
    }
    const [row] = await tx
      .insert(gridConfigs)
      .values({
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        kind: "keyword_rank",
        locationId: loc.id,
        keywords: [input.keyword],
        gridSize: 1,
        radiusM: GEOGRID_DEFAULTS.minRadiusM,
        centerLat: input.centerLat,
        centerLng: input.centerLng,
        targetName: loc.title ?? loc.name,
        targetPlaceId: input.targetPlaceId ?? null,
        targetDomain: domain,
        driverId: "dataforseo_serp",
        schedule: input.schedule,
        createdBy: actor.userId,
      })
      .returning();
    await audit({
      action: "rankings.tracker_created",
      entityType: "grid_config",
      entityId: row!.id,
      before: null,
      after: row,
    });
    return { configId: row!.id, keyword: input.keyword, trackerCreated: true, keywordAdded: true };
  },
});

export const rankingsUntrack = defineAction({
  name: "rankings.untrack",
  description:
    "Stop tracking a keyword (matched case-insensitively) on a keyword tracker. Its past positions stay in the history; removing the last keyword deletes the tracker and its history. Needs geogrid:manage.",
  input: z.object({ configId: z.uuid(), keyword: z.string().trim().min(1).max(120) }),
  output: z.object({ configId: z.string(), remainingKeywords: z.number() }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadRankConfig(tx, actor, input.configId);
    authorize(actor, "geogrid:manage", { workspaceId: before.workspaceId });
    if (!before.keywords.some((k) => lc(k) === lc(input.keyword))) {
      throw new CoreError("INVALID_INPUT", `"${input.keyword}" is not tracked`);
    }
    const keywords = before.keywords.filter((k) => lc(k) !== lc(input.keyword));
    if (keywords.length === 0) {
      await tx.delete(gridConfigs).where(eq(gridConfigs.id, before.id));
      await audit({ action: "rankings.tracker_deleted", entityType: "grid_config", entityId: before.id, before, after: null });
      return { configId: before.id, remainingKeywords: 0 };
    }
    const [row] = await tx
      .update(gridConfigs)
      .set({
        keywords,
        favoriteKeywords: before.favoriteKeywords.filter((k) => lc(k) !== lc(input.keyword)),
        updatedAt: new Date(),
      })
      .where(eq(gridConfigs.id, before.id))
      .returning();
    await audit({ action: "rankings.keyword_untracked", entityType: "grid_config", entityId: before.id, before, after: row });
    return { configId: before.id, remainingKeywords: keywords.length };
  },
});

export const rankingsSetFavorite = defineAction({
  name: "rankings.setFavorite",
  description:
    "Star or unstar a tracked keyword (matched case-insensitively). Starred keywords are listed first. Needs geogrid:manage.",
  input: z.object({ configId: z.uuid(), keyword: z.string().trim().min(1).max(120), favorite: z.boolean() }),
  output: z.object({ configId: z.string(), favoriteKeywords: z.array(z.string()) }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadRankConfig(tx, actor, input.configId);
    authorize(actor, "geogrid:manage", { workspaceId: before.workspaceId });
    const kw = before.keywords.find((k) => lc(k) === lc(input.keyword));
    if (!kw) throw new CoreError("INVALID_INPUT", `"${input.keyword}" is not tracked`);
    const rest = before.favoriteKeywords.filter((k) => lc(k) !== lc(kw));
    const favoriteKeywords = input.favorite ? [...rest, kw] : rest;
    await tx
      .update(gridConfigs)
      .set({ favoriteKeywords, updatedAt: new Date() })
      .where(eq(gridConfigs.id, before.id));
    await audit({
      action: "rankings.favorite_set",
      entityType: "grid_config",
      entityId: before.id,
      before: { favoriteKeywords: before.favoriteKeywords },
      after: { favoriteKeywords },
    });
    return { configId: before.id, favoriteKeywords };
  },
});

const reading = z.object({
  /** UTC day of the check, YYYY-MM-DD. */
  date: z.string(),
  /** Position in the Google local pack (1 to 3); null = not in it. */
  localPackRank: z.number().nullable(),
  /** Position of the website in the organic results; null = not in the results fetched, or no website known. */
  organicRank: z.number().nullable(),
  organicUrl: z.string().nullable(),
  /** fixture and sandbox are sample data; only live is real Google. */
  dataSource: z.enum(["fixture", "sandbox", "live"]),
});

export const rankingsList = defineAction({
  name: "rankings.list",
  description:
    "Keyword rank trackers the caller can see, one per location, each with its keywords (starred first) and their daily positions: the latest reading, the one before it, and `history` (one reading per UTC day, oldest first, the last `days` days, default 30). localPackRank is the position in Google's local pack, organicRank the website's position in the organic results; null means not found. dataSource tells whether a reading is real (live) or sample data. Optional filters: workspaceId, locationId. Needs geogrid:read.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    days: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    trackers: z.array(
      z.object({
        configId: z.string(),
        workspaceId: z.string(),
        locationId: z.string(),
        locationTitle: z.string(),
        targetDomain: z.string().nullable(),
        schedule: z.enum(gridSchedules),
        active: z.boolean(),
        /** When the daily schedule job will next check this tracker (UTC). Null for manual or inactive. */
        nextRunAt: z.string().nullable(),
        keywords: z.array(
          z.object({
            keyword: z.string(),
            favorite: z.boolean(),
            latest: reading.nullable(),
            previous: reading.nullable(),
            history: z.array(reading),
          }),
        ),
      }),
    ),
  }),
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "geogrid:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const configs = await tx
      .select({ config: gridConfigs, locationTitle: locations.title, locationName: locations.name })
      .from(gridConfigs)
      .innerJoin(locations, eq(locations.id, gridConfigs.locationId))
      .where(
        and(
          eq(gridConfigs.orgId, actor.orgId),
          eq(gridConfigs.kind, "keyword_rank"),
          scope === "all" ? undefined : inArray(gridConfigs.workspaceId, scope),
          input.workspaceId ? eq(gridConfigs.workspaceId, input.workspaceId) : undefined,
          input.locationId ? eq(gridConfigs.locationId, input.locationId) : undefined,
        ),
      )
      .orderBy(asc(gridConfigs.createdAt), asc(gridConfigs.id));
    const ids = configs.map((c) => c.config.id);
    const since = new Date(Date.now() - input.days * 86_400_000);
    const rows = ids.length
      ? await tx
          .select({
            configId: gridRuns.configId,
            keyword: gridRuns.keyword,
            createdAt: gridRuns.createdAt,
            dataSource: gridRuns.dataSource,
            rank: gridPoints.rank,
            organicRank: gridPoints.organicRank,
            organicUrl: gridPoints.organicUrl,
          })
          .from(gridRuns)
          .innerJoin(gridPoints, eq(gridPoints.runId, gridRuns.id))
          .where(and(inArray(gridRuns.configId, ids), eq(gridRuns.status, "done"), gte(gridRuns.createdAt, since)))
          .orderBy(asc(gridRuns.createdAt), asc(gridRuns.id))
      : [];
    return {
      trackers: configs.map(({ config, locationTitle, locationName }) => {
        // One reading per UTC day: a second check the same day replaces the first (rows are oldest first).
        const keywords = config.keywords.map((keyword) => {
          const byDay = new Map<string, z.input<typeof reading>>();
          for (const r of rows) {
            if (r.configId !== config.id || lc(r.keyword) !== lc(keyword)) continue;
            const date = r.createdAt.toISOString().slice(0, 10);
            byDay.set(date, {
              date,
              localPackRank: r.rank,
              organicRank: r.organicRank,
              organicUrl: r.organicUrl,
              dataSource: r.dataSource,
            });
          }
          const history = [...byDay.values()];
          return {
            keyword,
            favorite: config.favoriteKeywords.some((f) => lc(f) === lc(keyword)),
            latest: history.at(-1) ?? null,
            previous: history.at(-2) ?? null,
            history,
          };
        });
        keywords.sort((a, b) => Number(b.favorite) - Number(a.favorite));
        return {
          configId: config.id,
          workspaceId: config.workspaceId,
          locationId: config.locationId!,
          locationTitle: locationTitle ?? locationName,
          targetDomain: config.targetDomain,
          schedule: config.schedule,
          active: config.active,
          nextRunAt: config.active
            ? (nextScheduledRunAt(config.schedule, config.lastScheduledAt, new Date())?.toISOString() ?? null)
            : null,
          keywords,
        };
      }),
    };
  },
});
