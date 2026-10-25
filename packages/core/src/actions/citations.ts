import { useAccountDaily } from "../limits/counters";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { citationCheckResult, citationEntries, citationStatus } from "@opengmb/db";
import { runChecks } from "../citations/check";
import { CITATION_CHECK } from "../config/citation-check";
import { CITATION_COUNTRIES, CITATION_SITES_VERIFIED_ON, citationCountryFor, citationSiteByKey, citationSitesFor } from "../config/citation-sites";
import { CoreError } from "../errors";
import { locationRegionCode } from "../locations/center";
import { assertHttpsUrl, loadLocation } from "../locationOps/access";
import { defineAction } from "../registry";

const URL_MAX = 2000;
const TEXT_MAX = 500;
const NOTES_MAX = 2000;

const status = z.enum(citationStatus);
const country = z.enum(CITATION_COUNTRIES as [string, ...string[]]);

const checkOut = z.enum(citationCheckResult);

const entryOut = z.object({
  id: z.string(),
  status: status,
  listingUrl: z.string().nullable(),
  emailUsed: z.string().nullable(),
  nameUsed: z.string().nullable(),
  addressUsed: z.string().nullable(),
  phoneUsed: z.string().nullable(),
  submittedOn: z.string().nullable(),
  notes: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checkResult: checkOut.nullable(),
  checkFields: z.object({ name: z.string().optional(), address: z.string().optional(), phone: z.string().optional() }).nullable(),
  checkReason: z.string().nullable(),
  updatedAt: z.string(),
});
type EntryOut = z.infer<typeof entryOut>;

const toEntry = (e: typeof citationEntries.$inferSelect): EntryOut => ({
  id: e.id,
  status: e.status,
  listingUrl: e.listingUrl,
  emailUsed: e.emailUsed,
  nameUsed: e.nameUsed,
  addressUsed: e.addressUsed,
  phoneUsed: e.phoneUsed,
  submittedOn: e.submittedOn,
  notes: e.notes,
  checkedAt: e.checkedAt?.toISOString() ?? null,
  checkResult: e.checkResult,
  checkFields: e.checkDetail?.fields ?? null,
  checkReason: e.checkDetail?.reason ?? null,
  updatedAt: e.updatedAt.toISOString(),
});

const siteOut = z.object({
  key: z.string(),
  name: z.string(),
  claimUrl: z.string(),
  sourceUrl: z.string(),
  cost: z.enum(["free", "paid"]),
  type: z.enum(["core", "general", "social", "maps"]),
  priority: z.number(),
  entry: entryOut.nullable(),
});

const customOut = z.object({ name: z.string(), url: z.string().nullable(), entry: entryOut });

export const citationsList = defineAction({
  name: "citations.list",
  description:
    "The citation tracker of one location: the curated list of business directories and listing sites for the location's country (name, claim or sign-up URL, free or paid, type core/general/social/maps, priority 1 first), each merged with what has been recorded for it (status not_started, submitted, live or needs_fix; listing URL; the email, name, address and phone used; submitted date; notes), plus the custom sites added by hand, and a summary count. The country comes from the Google storefront address (one Google read, outside any transaction); when it is unreadable, empty or not one of the listed countries the US list is used (countrySource fallback). Pass country to choose a list yourself (countrySource chosen). The list is config (config/citation-sites.ts) with a source URL per site, checked on listVerifiedOn. Logins and passwords are never stored. Read only. Needs location:read.",
  input: z.object({ locationId: z.uuid(), country: country.optional() }),
  output: z.object({
    locationId: z.string(),
    location: z.object({ name: z.string(), addressSummary: z.string().nullable(), phone: z.string().nullable() }),
    country: z.string(),
    countrySource: z.enum(["google", "chosen", "fallback"]),
    listVerifiedOn: z.string(),
    sites: z.array(siteOut),
    custom: z.array(customOut),
    summary: z.object({
      total: z.number(),
      live: z.number(),
      submitted: z.number(),
      needsFix: z.number(),
      notStarted: z.number(),
    }),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    let code: string | null = input.country ?? null;
    let source: "google" | "chosen" | "fallback" = input.country ? "chosen" : "fallback";
    if (!code) {
      code = await locationRegionCode(db, loc);
      if (code && citationCountryFor(code) === code) source = "google";
    }
    const resolved = citationCountryFor(code);
    const rows = await db.select().from(citationEntries).where(eq(citationEntries.locationId, loc.id));
    const byKey = new Map(rows.filter((r) => r.siteKey).map((r) => [r.siteKey!, r]));
    const sites = citationSitesFor(resolved).map((s) => ({
      key: s.key,
      name: s.name,
      claimUrl: s.claimUrl,
      sourceUrl: s.sourceUrl,
      cost: s.cost,
      type: s.type,
      priority: s.priority,
      entry: byKey.has(s.key) ? toEntry(byKey.get(s.key)!) : null,
    }));
    const custom = rows
      .filter((r) => !r.siteKey)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ name: r.customName ?? "", url: r.customUrl, entry: toEntry(r) }));
    const statuses = [...sites.map((s) => s.entry?.status ?? "not_started"), ...custom.map((c) => c.entry.status)];
    const count = (st: string) => statuses.filter((x) => x === st).length;
    return {
      locationId: loc.id,
      location: { name: loc.title ?? loc.name, addressSummary: loc.addressSummary, phone: loc.phone },
      country: resolved,
      countrySource: source,
      listVerifiedOn: CITATION_SITES_VERIFIED_ON,
      sites,
      custom,
      summary: {
        total: statuses.length,
        live: count("live"),
        submitted: count("submitted"),
        needsFix: count("needs_fix"),
        notStarted: count("not_started"),
      },
    };
  },
});

const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim()));
const fields = {
  status: status.optional(),
  listingUrl: text(URL_MAX),
  emailUsed: text(TEXT_MAX),
  nameUsed: text(TEXT_MAX),
  addressUsed: text(TEXT_MAX),
  phoneUsed: text(TEXT_MAX),
  submittedOn: z.iso.date().nullable().optional(),
  notes: text(NOTES_MAX),
};
type Fields = { [K in keyof typeof fields]?: z.output<(typeof fields)[K]> };

/** Only the fields that were sent; undefined leaves a column as it is, null clears it. */
function patchOf(input: Fields): Fields {
  const out: Fields = {};
  for (const k of Object.keys(fields) as (keyof Fields)[]) if (input[k] !== undefined) (out as Record<string, unknown>)[k] = input[k];
  if (out.listingUrl) assertHttpsUrl(out.listingUrl, { maxLength: URL_MAX });
  return out;
}

export const citationsSave = defineAction({
  name: "citations.save",
  description:
    "Record what happened for one citation site at one location. Give siteKey (a site from citations.list) to create or update its entry, or id (an entry id from citations.list, for a custom site) to update that one. Only the fields sent change; null or an empty string clears a text field. status: not_started, submitted, live, needs_fix. listingUrl must be https (kept so the listing can be checked later). submittedOn is a date (YYYY-MM-DD). There is no field for a password or login: keep logins in a password manager. Does not contact the site. Needs profile:edit (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    siteKey: z.string().max(80).optional(),
    id: z.uuid().optional(),
    ...fields,
  }),
  output: z.object({ entry: entryOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    if (Boolean(input.siteKey) === Boolean(input.id)) throw new CoreError("INVALID_INPUT", "Give either siteKey or id");
    const patch = patchOf(input);
    const now = new Date();
    const [existing] = await tx
      .select()
      .from(citationEntries)
      .where(
        and(
          eq(citationEntries.locationId, loc.id),
          input.id ? eq(citationEntries.id, input.id) : eq(citationEntries.siteKey, input.siteKey!),
        ),
      );
    if (input.id && !existing) throw new CoreError("NOT_FOUND", "Citation entry not found");
    if (existing) {
      const [row] = await tx
        .update(citationEntries)
        .set({ ...patch, updatedBy: actor.userId, updatedAt: now })
        .where(eq(citationEntries.id, existing.id))
        .returning();
      await audit({
        action: "citation.updated",
        entityType: "citation_entry",
        entityId: existing.id,
        before: { status: existing.status },
        after: { status: row!.status, locationId: loc.id, siteKey: existing.siteKey },
      });
      return { entry: toEntry(row!) };
    }
    if (!citationSiteByKey(input.siteKey!)) throw new CoreError("INVALID_INPUT", "Unknown citation site");
    const [row] = await tx
      .insert(citationEntries)
      .values({
        ...patch,
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        siteKey: input.siteKey!,
        updatedBy: actor.userId,
      })
      .returning();
    await audit({
      action: "citation.created",
      entityType: "citation_entry",
      entityId: row!.id,
      after: { status: row!.status, locationId: loc.id, siteKey: row!.siteKey },
    });
    return { entry: toEntry(row!) };
  },
});

export const citationsAddCustom = defineAction({
  name: "citations.addCustom",
  description:
    "Add a site that is not in the curated list to one location's tracker (for example a local chamber of commerce or an industry directory). name is required; url is the site's https address and optional. It starts as not_started; update it with citations.save using the returned entry id. Needs profile:edit (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    url: z.string().max(URL_MAX).optional(),
  }),
  output: z.object({ custom: customOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const url = input.url?.trim() || null;
    if (url) assertHttpsUrl(url, { maxLength: URL_MAX });
    const [row] = await tx
      .insert(citationEntries)
      .values({
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        customName: input.name,
        customUrl: url,
        updatedBy: actor.userId,
      })
      .returning();
    await audit({
      action: "citation.custom_added",
      entityType: "citation_entry",
      entityId: row!.id,
      after: { locationId: loc.id, name: input.name },
    });
    return { custom: { name: row!.customName ?? "", url: row!.customUrl, entry: toEntry(row!) } };
  },
});

export const citationsDeleteCustom = defineAction({
  name: "citations.deleteCustom",
  description:
    "Remove a custom site (one added with citations.addCustom) and its notes from a location's tracker. Sites from the curated list cannot be deleted; set them back to not_started instead. Needs profile:edit (owner, admin, manager).",
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.literal(true) }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [row] = await tx
      .select()
      .from(citationEntries)
      .where(and(eq(citationEntries.id, input.id), eq(citationEntries.orgId, actor.orgId)));
    if (!row) throw new CoreError("NOT_FOUND", "Citation entry not found");
    const loc = await loadLocation(tx, actor, row.locationId, "profile:edit");
    if (row.siteKey) throw new CoreError("INVALID_INPUT", "Only custom sites can be deleted");
    await tx.delete(citationEntries).where(eq(citationEntries.id, row.id));
    await audit({
      action: "citation.custom_deleted",
      entityType: "citation_entry",
      entityId: row.id,
      before: { locationId: loc.id, name: row.customName },
    });
    return { deleted: true as const };
  },
});

const checkSummary = z.object({
  match: z.number(),
  mismatch: z.number(),
  notFound: z.number(),
  couldNotFetch: z.number(),
});

const profileOf = (loc: { title: string | null; name: string; addressSummary: string | null; phone: string | null }) => ({
  name: loc.title ?? loc.name,
  address: loc.addressSummary,
  phone: loc.phone,
});

export const citationsCheck = defineAction({
  name: "citations.check",
  description:
    "Check one citation listing against the Google profile. Give siteKey (a site from citations.list) or id (an entry id). The entry must have a listingUrl. The page is fetched from the server (http or https only, never a private or internal address, at most 3 redirects, a time and size limit, html only) and the business name, address and phone found on it are compared with the location's Google profile name, address and phone. Result: match, mismatch (checkFields says which of name, address, phone), not_found (the page loaded but the details could not be found, or the page is gone) or could_not_fetch (checkReason says why; many directories block automatic checks, so open the listing to compare). A failed fetch is never a mismatch. The result and time are stored on the entry (checkedAt, checkResult). Free. Runs on demand only. Needs profile:edit (owner, admin, manager).",
  input: z.object({ locationId: z.uuid(), siteKey: z.string().max(80).optional(), id: z.uuid().optional() }),
  output: z.object({ entry: entryOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    if (Boolean(input.siteKey) === Boolean(input.id)) throw new CoreError("INVALID_INPUT", "Give either siteKey or id");
    const [existing] = await tx
      .select()
      .from(citationEntries)
      .where(
        and(
          eq(citationEntries.locationId, loc.id),
          input.id ? eq(citationEntries.id, input.id) : eq(citationEntries.siteKey, input.siteKey!),
        ),
      );
    if (!existing) throw new CoreError("NOT_FOUND", "Citation entry not found");
    if (!existing.listingUrl) throw new CoreError("INVALID_INPUT", "Add the link to the listing before checking it");
    await useAccountDaily(tx, actor.orgId, "citation_check", 1);
    const [outcome] = await runChecks([{ url: existing.listingUrl }], profileOf(loc));
    if (!outcome) throw new Error("The check did not run");
    const now = new Date();
    const [row] = await tx
      .update(citationEntries)
      .set({ checkedAt: now, checkResult: outcome.result, checkDetail: outcome.detail })
      .where(eq(citationEntries.id, existing.id))
      .returning();
    await audit({
      action: "citation.checked",
      entityType: "citation_entry",
      entityId: existing.id,
      after: { result: outcome.result, locationId: loc.id, siteKey: existing.siteKey },
    });
    return { entry: toEntry(row!) };
  },
});

export const citationsCheckAll = defineAction({
  name: "citations.checkAll",
  description:
    `Check the live listings of one location against the Google profile (same checks as citations.check). Takes entries with status live and a listingUrl, the ones never checked or checked longest ago first, at most ${CITATION_CHECK.maxPerRun} per run and about ${CITATION_CHECK.runBudgetMs / 1000} seconds (different sites are fetched at the same time); run it again to reach the rest (remaining says how many were left). Fetches to the same site are spaced apart. Returns the checked entries and a count per result. Fails with INVALID_INPUT when no live entry has a listingUrl. Free. Runs on demand only. Needs profile:edit (owner, admin, manager).`,
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ entries: z.array(entryOut), summary: checkSummary, remaining: z.number() }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const live = await tx
      .select()
      .from(citationEntries)
      .where(and(eq(citationEntries.locationId, loc.id), eq(citationEntries.status, "live"), sql`${citationEntries.listingUrl} IS NOT NULL`))
      .orderBy(sql`${citationEntries.checkedAt} ASC NULLS FIRST`, asc(citationEntries.createdAt));
    if (live.length === 0) throw new CoreError("INVALID_INPUT", "No live listing has a link to check. Mark a listing live and add its link first.");
    const batch = live.slice(0, CITATION_CHECK.maxPerRun);
    await useAccountDaily(tx, actor.orgId, "citation_check", batch.length);
    const outcomes = await runChecks(batch.map((e) => ({ url: e.listingUrl! })), profileOf(loc));
    const now = new Date();
    const entries: EntryOut[] = [];
    const summary = { match: 0, mismatch: 0, notFound: 0, couldNotFetch: 0 };
    let unchecked = 0;
    for (const [i, e] of batch.entries()) {
      const o = outcomes[i];
      if (!o) {
        unchecked++;
        continue;
      }
      const [row] = await tx
        .update(citationEntries)
        .set({ checkedAt: now, checkResult: o.result, checkDetail: o.detail })
        .where(eq(citationEntries.id, e.id))
        .returning();
      await audit({
        action: "citation.checked",
        entityType: "citation_entry",
        entityId: e.id,
        after: { result: o.result, locationId: loc.id, siteKey: e.siteKey },
      });
      if (o.result === "match") summary.match++;
      else if (o.result === "mismatch") summary.mismatch++;
      else if (o.result === "not_found") summary.notFound++;
      else summary.couldNotFetch++;
      entries.push(toEntry(row!));
    }
    return { entries, summary, remaining: live.length - batch.length + unchecked };
  },
});
