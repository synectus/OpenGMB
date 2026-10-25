import { eq } from "drizzle-orm";
import { z } from "zod";
import { aiVisibilitySettings, type Db, type Tx } from "@opengmb/db";
import { AI_ENGINES, AI_VISIBILITY } from "../config/ai-visibility";
import { CoreError } from "../errors";
import { monthToDateUsd, getGridBilling } from "../geogrid/cost";
import { enqueueJob } from "../jobs";
import { defineAction } from "../registry";
import { roleHasPermission } from "../permissions";
import { loadLocation } from "../locationOps/access";
import { AI_VISIBILITY_QUEUE, checkEstimate, cleanEngines } from "../ai-visibility/run";
import { aiVisibilityOverview } from "../ai-visibility/read";

const engineEnum = z.enum(AI_ENGINES);
const sourceEnum = z.enum(["fixture", "sandbox", "live"]);
/** A manual check is refused this soon after the last one, so a double click cannot buy two. */
const MANUAL_GAP_MS = 60 * 60 * 1000;

const settingsOut = z.object({
  enabled: z.boolean(),
  category: z.string(),
  city: z.string(),
  engines: z.array(engineEnum),
  lastCheckedAt: z.string().nullable(),
});

const getOut = z.object({
  locationId: z.string(),
  settings: settingsOut,
  engineLabels: z.record(z.string(), z.string()),
  /** What one weekly check costs, markup included, for the chosen engines. Null unless the role has geogrid:cost. */
  estimate: z
    .object({ prompts: z.number(), providerUsd: z.number(), chargedUsd: z.number(), monthToDateUsd: z.number(), monthlyBudgetUsd: z.number() })
    .nullable(),
  trend: z.array(
    z.object({
      runId: z.string(),
      date: z.string(),
      dataSource: sourceEnum,
      engines: z.record(z.string(), z.object({ mentioned: z.number(), answered: z.number(), rate: z.number() })),
    }),
  ),
  latest: z
    .object({
      date: z.string(),
      dataSource: sourceEnum,
      results: z.array(
        z.object({ engine: engineEnum, prompt: z.string(), mentioned: z.boolean(), position: z.number().nullable(), competitors: z.array(z.string()), excerpt: z.string(), error: z.string().nullable() }),
      ),
      competitors: z.array(z.object({ name: z.string(), mentions: z.number() })),
    })
    .nullable(),
});

async function readOne(tx: Db | Tx, locationId: string) {
  const [row] = await tx.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.locationId, locationId));
  return {
    enabled: row?.enabled ?? false,
    category: row?.category ?? "",
    city: row?.city ?? "",
    engines: cleanEngines(row?.engines),
    lastCheckedAt: row?.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
  };
}

export const aiVisibilityGet = defineAction({
  name: "aiVisibility.get",
  description:
    "AI search visibility for one location (paid add-on, off until switched on): the settings (enabled, category, city, engines), the cost of one weekly check, the mention rate per engine (ChatGPT, Gemini, Perplexity, Google AI Overviews) for each of the last 12 checks, and the latest check's answers with the competitors named. estimate is null unless the role has geogrid:cost. Reads stored data only. Needs geogrid:read.",
  input: z.object({ locationId: z.uuid() }),
  output: getOut,
  permission: "geogrid:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "geogrid:read");
    const settings = await readOne(tx, loc.id);
    let estimate = null;
    if (roleHasPermission(actor.role, "geogrid:cost")) {
      const e = await checkEstimate(tx, actor.orgId, settings.engines);
      const billing = await getGridBilling(tx, actor.orgId);
      estimate = { ...e, monthToDateUsd: await monthToDateUsd(tx, actor.orgId, new Date()), monthlyBudgetUsd: billing.monthlyBudgetUsd };
    }
    const o = await aiVisibilityOverview(tx, actor.orgId, loc.id);
    return {
      locationId: loc.id,
      settings,
      engineLabels: Object.fromEntries(AI_ENGINES.map((e) => [e, AI_VISIBILITY.engines[e].label])),
      estimate,
      trend: o.trend,
      latest: o.latest,
    };
  },
});

export const aiVisibilityUpdate = defineAction({
  name: "aiVisibility.update",
  description:
    "Switch AI search visibility on or off for one location and set what it asks about: category (for example 'dentist') and city, from which the weekly prompts are built ('best dentist in Austin' plus the tracked keywords). engines defaults to all four. Switching on needs a category and a city. Each weekly check costs money (see aiVisibility.get estimate) and is charged like rank scans. Needs geogrid:manage (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    enabled: z.boolean(),
    category: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    engines: z.array(engineEnum).min(1).optional(),
  }),
  output: settingsOut,
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "geogrid:manage");
    const before = await readOne(tx, loc.id);
    const next = {
      enabled: input.enabled,
      category: input.category ?? before.category,
      city: input.city ?? before.city,
      engines: input.engines ? cleanEngines(input.engines) : before.engines,
    };
    if (next.enabled && (!next.category || !next.city)) throw new CoreError("INVALID_INPUT", "Give a category and a city before switching AI search visibility on");
    if (next.enabled && loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is inactive");
    await tx
      .insert(aiVisibilitySettings)
      .values({ locationId: loc.id, orgId: actor.orgId, ...next, updatedBy: actor.userId })
      .onConflictDoUpdate({ target: aiVisibilitySettings.locationId, set: { ...next, updatedAt: new Date(), updatedBy: actor.userId } });
    await audit({ action: "ai_visibility.settings_updated", entityType: "location", entityId: loc.id, before, after: next });
    return { ...next, lastCheckedAt: before.lastCheckedAt };
  },
});

export const aiVisibilityRunNow = defineAction({
  name: "aiVisibility.runNow",
  description:
    "Queue an AI search visibility check for one location now instead of waiting for the weekly one. The location must be switched on. It costs the same as a weekly check, counts against the monthly AI budget and any usage charge, and is refused within an hour of the last check. The answers appear in aiVisibility.get when the worker has finished (usually a minute or two). Needs geogrid:manage (owner, admin, manager).",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ queued: z.boolean() }),
  permission: "geogrid:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "geogrid:manage");
    const s = await readOne(tx, loc.id);
    if (!s.enabled) throw new CoreError("INVALID_INPUT", "Switch AI search visibility on for this location first");
    if (s.lastCheckedAt && Date.now() - new Date(s.lastCheckedAt).getTime() < MANUAL_GAP_MS) {
      throw new CoreError("INVALID_INPUT", "A check ran in the last hour. Try again later.");
    }
    await enqueueJob(tx, AI_VISIBILITY_QUEUE, { locationId: loc.id, force: true });
    await audit({ action: "ai_visibility.check_requested", entityType: "location", entityId: loc.id, before: null, after: { force: true } });
    return { queued: true };
  },
});
