import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, profileSnapshots, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { BULK_POST_LIMITS } from "../config/bulk-post-limits";
import { CoreError } from "../errors";
import { checkPostAtLocations } from "../posts/context";
import { mergeContent, type PostContent } from "../posts/content";
import { buildBulkRows, type BulkLocation, type BulkParse } from "../posts/bulk/rows";
import { cityFromAddress } from "../posts/bulk/variables";
import { defineAction } from "../registry";
import { authorizeWorkspace, insertDraft, workspaceTimeZone } from "./posts";

const csvInput = z.string().min(1).max(BULK_POST_LIMITS.maxChars);
const inputShape = { workspaceId: z.uuid(), csv: csvInput };

/**
 * The active locations of a workspace with the values a post can use as {name}, {city} ...:
 * locations.title/name/phone/address_summary, and websiteUri from the newest profile snapshot (stored at data.fields.websiteUri).
 */
async function loadBulkLocations(tx: Tx, actor: Actor, workspaceId: string): Promise<BulkLocation[]> {
  const rows = await tx
    .select({
      id: locations.id,
      name: locations.name,
      title: locations.title,
      phone: locations.phone,
      addressSummary: locations.addressSummary,
    })
    .from(locations)
    .where(
      and(
        eq(locations.orgId, actor.orgId),
        eq(locations.workspaceId, workspaceId),
        eq(locations.status, "active"),
      ),
    );
  const sites = new Map<string, string | null>();
  if (rows.length > 0) {
    const snaps = await tx
      .selectDistinctOn([profileSnapshots.locationId], {
        locationId: profileSnapshots.locationId,
        website: sql<string | null>`${profileSnapshots.data}->'fields'->>'websiteUri'`,
      })
      .from(profileSnapshots)
      .where(
        and(
          eq(profileSnapshots.orgId, actor.orgId),
          inArray(
            profileSnapshots.locationId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(profileSnapshots.locationId, desc(profileSnapshots.takenAt));
    for (const s of snaps) sites.set(s.locationId, s.website);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    vars: {
      name: r.title ?? r.name,
      city: cityFromAddress(r.addressSummary),
      phone: r.phone,
      address: r.addressSummary,
      website: sites.get(r.id) ?? null,
    },
  }));
}

async function parseBulk(
  tx: Tx,
  actor: Actor,
  input: { workspaceId: string; csv: string },
): Promise<BulkParse & { timeZone: string }> {
  await authorizeWorkspace(tx, actor, input.workspaceId, "review:draft");
  const timeZone = await workspaceTimeZone(tx, input.workspaceId);
  const parsed = buildBulkRows(input.csv, {
    locations: await loadBulkLocations(tx, actor, input.workspaceId),
    timeZone,
    now: new Date(),
  });
  return { ...parsed, timeZone };
}

const rowOut = z.object({
  line: z.number().int(),
  location: z.string().nullable(),
  topicType: z.enum(["STANDARD", "EVENT", "OFFER"]).nullable(),
  /** The post text with its variables filled in (cut to 400 characters). */
  summary: z.string(),
  scheduledFor: z.string().nullable(),
  /** A row with errors cannot be created. */
  errors: z.array(z.string()),
  /** Guardrail findings: the draft is still created, but cannot be submitted until they are fixed. */
  warnings: z.array(z.string()),
});

const PREVIEW_CHARS = 400;

export const postsBulkPreview = defineAction({
  name: "posts.bulkPreview",
  description: `Dry-run a bulk post import. csv is the text of a CSV file with a header row (get the columns from the Import page's template): location (name or id), type (STANDARD default, EVENT, OFFER), summary, optional cta_type, cta_url, scheduled (YYYY-MM-DD HH:MM in the client's time zone, remembered on the draft only), image_url, event_title, event_start_date, event_end_date, event_start_time, event_end_time, coupon_code, redeem_url, terms. Variables {name}, {city}, {phone}, {address}, {website} in any text are filled from each row's location; an unknown variable or one with no stored value for that location is a row error (never left blank). At most ${BULK_POST_LIMITS.maxRows} rows. Writes nothing. Returns per-row errors (the row cannot be created) and warnings (guardrail findings: the draft would exist but could not be submitted, for example a phone number written into the text). fileErrors means the file itself cannot be read and no rows are listed.`,
  input: z.object(inputShape),
  output: z.object({
    timeZone: z.string(),
    fileErrors: z.array(z.string()),
    rows: z.array(rowOut),
    total: z.number().int(),
    valid: z.number().int(),
    withErrors: z.number().int(),
  }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    const p = await parseBulk(tx, actor, input);
    const rows: z.input<typeof rowOut>[] = [];
    for (const r of p.rows) {
      const warnings: string[] = [];
      if (r.draft) {
        const c: PostContent = mergeContent(
          { topicType: r.draft.topicType, alertType: null, summary: "", cta: null, event: null, offer: null, media: [] },
          r.draft,
        );
        const g = await checkPostAtLocations(tx, {
          workspaceId: input.workspaceId,
          locationIds: [r.draft.locationId],
          content: c,
        });
        warnings.push(...g.violations.map((v) => v.message));
      }
      rows.push({
        line: r.line,
        location: r.locationName,
        topicType: r.draft?.topicType ?? null,
        summary: (r.draft?.summary ?? "").slice(0, PREVIEW_CHARS),
        scheduledFor: r.draft?.scheduledFor ?? null,
        errors: r.errors,
        warnings,
      });
    }
    const withErrors = p.rows.filter((r) => r.errors.length > 0).length;
    return {
      timeZone: p.timeZone,
      fileErrors: p.errors,
      rows,
      total: p.rows.length,
      valid: p.rows.length - withErrors,
      withErrors,
    };
  },
});

export const postsBulkCreateDrafts = defineAction({
  name: "posts.bulkCreateDrafts",
  description: `Create one DRAFT post per row of a CSV (same format and variables as posts.bulkPreview, at most ${BULK_POST_LIMITS.maxRows} rows). ALL OR NOTHING: the file is re-validated here, and if the file or any row has an error nothing is created (INVALID_INPUT lists the first problems; run posts.bulkPreview and fix them). Each draft is made exactly as posts.createDraft makes it (one location, the workspace's default language, audit row per draft), so it still needs posts.submit, approval and posts.schedule: nothing is submitted, scheduled or sent. Guardrail findings do not stop a draft (posts.check shows them; submit blocks).`,
  input: z.object(inputShape),
  output: z.object({
    created: z.number().int(),
    drafts: z.array(z.object({ postId: z.string(), line: z.number().int(), location: z.string() })),
  }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview({ read }, input) {
    const r = (await read("posts.bulkPreview", input)) as {
      fileErrors: string[];
      total: number;
      valid: number;
      withErrors: number;
    };
    const ok = r.fileErrors.length === 0 && r.total > 0 && r.withErrors === 0;
    return {
      summary: ok
        ? `Would create ${r.total} draft post(s). Nothing was written.`
        : `Would create nothing: ${r.fileErrors[0] ?? `${r.withErrors} of ${r.total} row(s) have errors`}. Nothing was written.`,
      diff: r,
    };
  },
  async handler(ctx, input) {
    const { tx, actor, audit } = ctx;
    const p = await parseBulk(tx, actor, input);
    const bad = p.rows.filter((r) => r.errors.length > 0);
    if (p.errors.length > 0 || bad.length > 0) {
      const first = bad.slice(0, 5).map((r) => `line ${r.line}: ${r.errors.join("; ")}`);
      throw new CoreError(
        "INVALID_INPUT",
        `Nothing was created. ${p.errors[0] ?? `${bad.length} of ${p.rows.length} rows have problems`}${first.length ? ` (${first.join(" | ")})` : ""}`,
      );
    }
    const drafts: { postId: string; line: number; location: string }[] = [];
    for (const r of p.rows) {
      const d = r.draft!;
      const row = await insertDraft(
        { tx, actor, audit },
        {
          workspaceId: input.workspaceId,
          locationIds: [d.locationId],
          topicType: d.topicType,
          summary: d.summary,
          cta: d.cta,
          event: d.event,
          offer: d.offer,
          media: d.media,
          ...(d.scheduledFor ? { scheduledFor: d.scheduledFor } : {}),
        },
      );
      drafts.push({ postId: row.id, line: r.line, location: r.locationName ?? "" });
    }
    await audit({
      action: "post.bulk_drafted",
      entityType: "workspace",
      entityId: input.workspaceId,
      before: null,
      after: { workspaceId: input.workspaceId, drafts: drafts.length },
    });
    return { created: drafts.length, drafts };
  },
});
