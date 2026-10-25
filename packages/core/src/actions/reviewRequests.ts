import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  reviewLinks,
  reviewRequestCampaigns,
  reviewRequestOptouts,
  reviewRequestRecipients,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { emailConfigured } from "../email";
import { CoreError } from "../errors";
import { LIST_SOURCE_KEYS, MAX_RECIPIENTS_PER_IMPORT, REMINDER_DAYS_DEFAULT, REMINDER_DAYS_MAX, REMINDER_DAYS_MIN } from "../config/review-requests";
import { runGuardrails, type GuardrailContext, type PackId, type Violation } from "../guardrails";
import { loadLocation } from "../locationOps/access";
import { defineAction } from "../registry";
import { sendingBlock } from "../review-requests/identity";
import { getWorkspaceReplySettings } from "../reviews/workspace-settings";
import {
  appBaseUrl,
  cleanRecipients,
  DEFAULT_BODY,
  DEFAULT_SUBJECT,
  fill,
  gatingProblem,
  newToken,
  parseRecipientsCsv,
  type ParsedRecipients,
} from "../review-requests/pure";

const subjectIn = z.string().trim().min(1).max(150);
const bodyIn = z.string().trim().min(1).max(1500);
const daysIn = z.number().int().min(REMINDER_DAYS_MIN).max(REMINDER_DAYS_MAX);

const resultsOut = z.object({
  recipients: z.number().int(),
  sent: z.number().int(),
  clicked: z.number().int(),
  optedOut: z.number().int(),
  reminderSent: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  waiting: z.number().int(),
});
const campaignOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  reminderEnabled: z.boolean(),
  reminderDays: z.number().int(),
  status: z.enum(["draft", "active", "cancelled"]),
  startedAt: z.string().nullable(),
  createdAt: z.string(),
  results: resultsOut,
});
const addedOut = z.object({ added: z.number().int(), duplicates: z.number().int(), invalid: z.number().int(), alreadyOptedOut: z.number().int() });
const recipientIn = z.object({ email: z.string().trim().min(3).max(254), name: z.string().trim().max(100).nullish() });
const permissionIn = z.literal(true, { error: "Confirm that you have read and follow the acceptable-use rules for these customers" });
const listSourceIn = z.enum(LIST_SOURCE_KEYS, { error: "Say how these customers were obtained" });

type CampaignRow = typeof reviewRequestCampaigns.$inferSelect;

async function loadCampaign(tx: Tx, actor: Actor, id: string, permission: "review:read" | "review:draft") {
  const [row] = await tx
    .select({ c: reviewRequestCampaigns, loc: locations })
    .from(reviewRequestCampaigns)
    .innerJoin(locations, eq(locations.id, reviewRequestCampaigns.locationId))
    .where(and(eq(reviewRequestCampaigns.id, id), eq(reviewRequestCampaigns.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  if (!row || (scope !== "all" && !scope.includes(row.c.workspaceId))) throw new AccessError("NOT_FOUND", "Campaign not found");
  authorize(actor, permission, { workspaceId: row.c.workspaceId });
  return row;
}

/** Refuses unless the client may send review requests: not a HIPAA covered entity, and legal name and postal address set. `identity: false` checks the HIPAA flag only (adding customers). */
async function requireMaySend(tx: Tx, workspaceId: string, o: { identity: boolean }) {
  const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const block = w ? sendingBlock(w) : null;
  if (block && (block.reason === "hipaa" || o.identity)) throw new CoreError("INVALID_INPUT", block.message);
}

async function resultsFor(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, z.infer<typeof resultsOut>>();
  const r = reviewRequestRecipients;
  const rows = await tx
    .select({
      id: r.campaignId,
      recipients: count(),
      sent: sql<number>`count(${r.sentAt})::int`,
      clicked: sql<number>`count(${r.clickedAt})::int`,
      optedOut: sql<number>`count(${r.optedOutAt})::int`,
      reminderSent: sql<number>`count(${r.reminderSentAt})::int`,
      skipped: sql<number>`(count(*) filter (where ${r.status} = 'skipped'))::int`,
      failed: sql<number>`(count(*) filter (where ${r.status} = 'failed'))::int`,
      waiting: sql<number>`(count(*) filter (where ${r.status} = 'pending'))::int`,
    })
    .from(r)
    .where(inArray(r.campaignId, ids))
    .groupBy(r.campaignId);
  return new Map(rows.map(({ id, ...rest }) => [id, rest]));
}
const ZERO = { recipients: 0, sent: 0, clicked: 0, optedOut: 0, reminderSent: 0, skipped: 0, failed: 0, waiting: 0 };

const shape = (c: CampaignRow, locationName: string, results: z.infer<typeof resultsOut> | undefined) => ({
  id: c.id,
  workspaceId: c.workspaceId,
  locationId: c.locationId,
  locationName,
  name: c.name,
  subject: c.subject,
  body: c.body,
  reminderEnabled: c.reminderEnabled,
  reminderDays: c.reminderDays,
  status: c.status,
  startedAt: c.startedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  results: results ?? ZERO,
});

/** Text problems that stop a start: wording that gates or asks for ratings, then the universal and post guardrail packs on subject and body. */
async function contentProblems(tx: Tx, c: Pick<CampaignRow, "workspaceId" | "subject" | "body">, loc: { name: string; title: string | null; phone: string | null }): Promise<string[]> {
  const business = loc.title ?? loc.name;
  const settings = await getWorkspaceReplySettings(tx, c.workspaceId);
  const problems: string[] = [];
  for (const [label, raw] of [["Subject", c.subject], ["Message", c.body]] as const) {
    const text = fill(raw, { name: null, business });
    const gate = gatingProblem(text);
    if (gate) problems.push(`${label}: ${gate}`);
    const ctx: GuardrailContext = {
      contentType: "post",
      post: { topicType: "STANDARD", alertType: null, cta: null, event: null, offer: null, media: [] },
      reply: text,
      review: { rating: null, text: null, reviewerDisplayName: null },
      location: { name: business, phone: loc.phone },
      workspace: {
        profile: settings.profile,
        packs: settings.packs as PackId[],
        skipPositiveReviews: settings.skipPositiveReviews,
        staffNames: settings.staffNames,
        ...(settings.h2Severity === "warn" ? { severityOverrides: { "H2.*": "warn" } } : {}),
      },
      recentReplies: [],
    };
    for (const v of runGuardrails(ctx).violations as Violation[]) if (v.severity === "block") problems.push(`${label}: ${v.message}`);
  }
  return problems;
}

async function addRows(tx: Tx, actor: Actor, c: CampaignRow, parsed: ParsedRecipients, listSource: string) {
  if (c.status === "cancelled") throw new CoreError("INVALID_INPUT", "This campaign was cancelled");
  const emails = parsed.rows.map((r) => r.email);
  const opted = new Set(
    emails.length
      ? (await tx.select({ email: reviewRequestOptouts.email }).from(reviewRequestOptouts).where(and(eq(reviewRequestOptouts.workspaceId, c.workspaceId), inArray(reviewRequestOptouts.email, emails)))).map((o) => o.email)
      : [],
  );
  const now = new Date();
  let added = 0;
  let alreadyOptedOut = 0;
  let duplicates = parsed.duplicates;
  for (let i = 0; i < parsed.rows.length; i += 200) {
    const chunk = parsed.rows.slice(i, i + 200);
    const inserted = await tx
      .insert(reviewRequestRecipients)
      .values(
        chunk.map((r) => {
          const out = opted.has(r.email);
          return {
            orgId: c.orgId,
            workspaceId: c.workspaceId,
            campaignId: c.id,
            email: r.email,
            name: r.name,
            linkToken: newToken(),
            listSource,
            listConfirmedBy: actor.userId,
            listConfirmedAt: now,
            ...(out ? { status: "skipped" as const, reason: "opted_out", optedOutAt: now } : {}),
          };
        }),
      )
      .onConflictDoNothing()
      .returning({ email: reviewRequestRecipients.email });
    for (const row of inserted) {
      if (opted.has(row.email)) alreadyOptedOut++;
      else added++;
    }
    duplicates += chunk.length - inserted.length;
  }
  return { added, duplicates, invalid: parsed.invalid, alreadyOptedOut };
}

export const reviewRequestsCreate = defineAction({
  name: "reviewRequests.create",
  description:
    "Create a draft email campaign that asks customers of one location to leave a Google review. Every recipient gets the same message and the same link to Google's review form; there is no rating question and no routing of unhappy customers. Refuses a location that has no review link yet (create it with reviewLinks.save first, it holds the Google place id). subject and body may use {name} and {business}; omitted, a plain default is used. At most one reminder, reminderDays (1 to 14, default 3) after the first email, only to people who have not clicked. Nothing is sent until reviewRequests.start. Needs review:draft (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    subject: subjectIn.optional(),
    body: bodyIn.optional(),
    reminderEnabled: z.boolean().default(true),
    reminderDays: daysIn.default(REMINDER_DAYS_DEFAULT),
  }),
  output: z.object({ campaignId: z.string() }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "review:draft");
    if (loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is not active");
    await requireMaySend(tx, loc.workspaceId, { identity: false });
    const [link] = await tx.select({ id: reviewLinks.id }).from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
    if (!link) throw new CoreError("INVALID_INPUT", "This location has no review link yet. Add its Google place id on the Requests tab first.");
    const [row] = await tx
      .insert(reviewRequestCampaigns)
      .values({
        orgId: actor.orgId,
        workspaceId: loc.workspaceId,
        locationId: loc.id,
        name: input.name,
        subject: input.subject ?? DEFAULT_SUBJECT,
        body: input.body ?? DEFAULT_BODY,
        reminderEnabled: input.reminderEnabled,
        reminderDays: input.reminderDays,
        createdBy: actor.userId,
      })
      .returning({ id: reviewRequestCampaigns.id });
    await audit({ action: "review_request.campaign_created", entityType: "review_request_campaign", entityId: row!.id, after: { locationId: loc.id, reminderEnabled: input.reminderEnabled, reminderDays: input.reminderDays } });
    return { campaignId: row!.id };
  },
});

export const reviewRequestsUpdate = defineAction({
  name: "reviewRequests.update",
  description: "Change a DRAFT review request campaign: name, subject, body, reminder on or off, reminder days (1 to 14). A started campaign cannot be edited (cancel it and make a new one). Needs review:draft.",
  input: z.object({
    campaignId: z.uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    subject: subjectIn.optional(),
    body: bodyIn.optional(),
    reminderEnabled: z.boolean().optional(),
    reminderDays: daysIn.optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, { campaignId, ...changes }) {
    const { c } = await loadCampaign(tx, actor, campaignId, "review:draft");
    if (c.status !== "draft") throw new CoreError("INVALID_INPUT", "Only a draft campaign can be edited");
    await tx.update(reviewRequestCampaigns).set({ ...changes, updatedAt: new Date() }).where(eq(reviewRequestCampaigns.id, c.id));
    await audit({ action: "review_request.campaign_updated", entityType: "review_request_campaign", entityId: c.id, after: { fields: Object.keys(changes) } });
    return { ok: true as const };
  },
});

export const reviewRequestsAddRecipients = defineAction({
  name: "reviewRequests.addRecipients",
  description:
    `Add customers (email and optional name) to a draft or running campaign, one or a few at a time. listSource is required, one of ${LIST_SOURCE_KEYS.join(", ")} (how the customers were obtained; each is stored with who confirmed and when). confirmPermission must be true: the caller confirms the acceptable-use rules (the people bought from, booked with or visited the business in the last 24 months; no bought, rented or scraped lists; everyone on the list is asked, never filtered by expected rating; not a HIPAA covered entity's patients). Recorded in the audit log, counts only, never the addresses. Addresses are lower-cased; duplicates, invalid addresses and addresses that opted out of this client earlier are not emailed and are counted in the answer. Needs review:draft.`,
  input: z.object({ campaignId: z.uuid(), recipients: z.array(recipientIn).min(1).max(MAX_RECIPIENTS_PER_IMPORT), listSource: listSourceIn, confirmPermission: permissionIn }),
  output: addedOut,
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { c } = await loadCampaign(tx, actor, input.campaignId, "review:draft");
    await requireMaySend(tx, c.workspaceId, { identity: false });
    const res = await addRows(tx, actor, c, cleanRecipients(input.recipients), input.listSource);
    await audit({ action: "review_request.recipients_added", entityType: "review_request_campaign", entityId: c.id, after: { source: "manual", listSource: input.listSource, permissionConfirmed: true, ...res } });
    return res;
  },
});

export const reviewRequestsImportCsv = defineAction({
  name: "reviewRequests.importCsv",
  description:
    `Add customers from CSV text to a draft or running campaign. The first row may be a header with an "email" column and a "name" or "first name" column; without a header column 1 is the email and column 2 the name. At most ${MAX_RECIPIENTS_PER_IMPORT} rows per import. listSource and confirmPermission as for addRecipients (confirmPermission is recorded in the audit log, counts only). Same rules as addRecipients. Needs review:draft.`,
  input: z.object({ campaignId: z.uuid(), csv: z.string().max(200_000), listSource: listSourceIn, confirmPermission: permissionIn }),
  output: addedOut,
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { c } = await loadCampaign(tx, actor, input.campaignId, "review:draft");
    await requireMaySend(tx, c.workspaceId, { identity: false });
    const parsed = parseRecipientsCsv(input.csv);
    if (parsed.tooMany) throw new CoreError("INVALID_INPUT", `Too many rows: import at most ${MAX_RECIPIENTS_PER_IMPORT} at a time`);
    if (parsed.rows.length === 0) throw new CoreError("INVALID_INPUT", "No valid email addresses found in the CSV");
    const res = await addRows(tx, actor, c, parsed, input.listSource);
    await audit({ action: "review_request.recipients_added", entityType: "review_request_campaign", entityId: c.id, after: { source: "csv", listSource: input.listSource, permissionConfirmed: true, ...res } });
    return res;
  },
});

export const reviewRequestsStart = defineAction({
  name: "reviewRequests.start",
  description:
    "Start a draft campaign. Refused unless the client has set its business legal name and postal address (workspaces.setSenderIdentity; both appear in every email) and is not a HIPAA covered entity (workspaces.setHipaa), email sending is set up, the public app URL is configured, the location still has its review link, there is at least one recipient waiting, and the subject and message pass the wording check (no ratings, stars, surveys or 'how was your visit') and the universal and post guardrail packs. Sending then happens in the background: the worker paces it (a daily limit for the whole server and one for each client, only 08:00 to 21:00 in the client's time zone). Every recipient on the list is emailed: there is no way to filter or pick recipients by rating or sentiment. Needs review:draft.",
  input: z.object({ campaignId: z.uuid() }),
  output: z.object({ ok: z.literal(true), waiting: z.number().int() }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { c, loc } = await loadCampaign(tx, actor, input.campaignId, "review:draft");
    if (c.status !== "draft") throw new CoreError("INVALID_INPUT", "Only a draft campaign can be started");
    await requireMaySend(tx, c.workspaceId, { identity: true });
    if (!emailConfigured()) throw new CoreError("NOT_CONFIGURED", "Email sending is not set up. An administrator adds the email key and sender address in Settings, Integrations.");
    if (!appBaseUrl()) throw new CoreError("NOT_CONFIGURED", "The public app address (BETTER_AUTH_URL) is not set, so links in the email cannot be built");
    if (loc.status !== "active") throw new CoreError("INVALID_INPUT", "Location is not active");
    const [link] = await tx.select({ id: reviewLinks.id }).from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
    if (!link) throw new CoreError("INVALID_INPUT", "This location has no review link (Google place id) any more");
    const problems = await contentProblems(tx, c, loc);
    if (problems.length > 0) throw new CoreError("INVALID_INPUT", `Cannot start: ${problems.join(" ")}`);
    const [w] = await tx
      .select({ n: count() })
      .from(reviewRequestRecipients)
      .where(and(eq(reviewRequestRecipients.campaignId, c.id), eq(reviewRequestRecipients.status, "pending")));
    if (!w || w.n === 0) throw new CoreError("INVALID_INPUT", "Add at least one customer to email first");
    await tx.update(reviewRequestCampaigns).set({ status: "active", startedAt: new Date(), updatedAt: new Date() }).where(eq(reviewRequestCampaigns.id, c.id));
    await audit({ action: "review_request.campaign_started", entityType: "review_request_campaign", entityId: c.id, before: { status: "draft" }, after: { status: "active", waiting: w.n, reminderEnabled: c.reminderEnabled, reminderDays: c.reminderDays } });
    return { ok: true as const, waiting: w.n };
  },
});

export const reviewRequestsCancel = defineAction({
  name: "reviewRequests.cancel",
  description: "Cancel a campaign: no further first emails or reminders go out. Emails already sent stay sent. Needs review:draft.",
  input: z.object({ campaignId: z.uuid() }),
  output: z.object({ ok: z.literal(true) }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { c } = await loadCampaign(tx, actor, input.campaignId, "review:draft");
    if (c.status === "cancelled") return { ok: true as const };
    await tx.update(reviewRequestCampaigns).set({ status: "cancelled", updatedAt: new Date() }).where(eq(reviewRequestCampaigns.id, c.id));
    await audit({ action: "review_request.campaign_cancelled", entityType: "review_request_campaign", entityId: c.id, before: { status: c.status }, after: { status: "cancelled" } });
    return { ok: true as const };
  },
});

export const reviewRequestsList = defineAction({
  name: "reviewRequests.list",
  description:
    "Review request email campaigns, newest first, each with its results: recipients, sent, clicked, opted out, reminder sent, skipped, failed, waiting. Optionally for one location. Counts only, no customer addresses. Delivery confirmation is not tracked. Needs review:read (client roles can view results).",
  input: z.object({ locationId: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50) }),
  output: z.object({ campaigns: z.array(campaignOut) }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const scope = workspaceScope(actor);
    if (scope !== "all" && scope.length === 0) return { campaigns: [] };
    const rows = await tx
      .select({ c: reviewRequestCampaigns, name: locations.name, title: locations.title })
      .from(reviewRequestCampaigns)
      .innerJoin(locations, eq(locations.id, reviewRequestCampaigns.locationId))
      .where(
        and(
          eq(reviewRequestCampaigns.orgId, actor.orgId),
          scope === "all" ? undefined : inArray(reviewRequestCampaigns.workspaceId, scope),
          input.locationId ? eq(reviewRequestCampaigns.locationId, input.locationId) : undefined,
        ),
      )
      .orderBy(desc(reviewRequestCampaigns.createdAt))
      .limit(input.limit);
    const results = await resultsFor(tx, rows.map((r) => r.c.id));
    return { campaigns: rows.map((r) => shape(r.c, r.title ?? r.name, results.get(r.c.id))) };
  },
});

export const reviewRequestsGet = defineAction({
  name: "reviewRequests.get",
  description: "One review request campaign with its results (counts only). Needs review:read.",
  input: z.object({ campaignId: z.uuid() }),
  output: campaignOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const { c, loc } = await loadCampaign(tx, actor, input.campaignId, "review:read");
    const results = await resultsFor(tx, [c.id]);
    return shape(c, loc.title ?? loc.name, results.get(c.id));
  },
});

export const reviewRequestsRecipients = defineAction({
  name: "reviewRequests.recipients",
  description: "The customers of a campaign with their status (email addresses and names: personal data). Needs review:draft, so client roles do not see it.",
  input: z.object({ campaignId: z.uuid(), limit: z.number().int().min(1).max(200).default(100), offset: z.number().int().min(0).default(0) }),
  output: z.object({
    total: z.number().int(),
    recipients: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        name: z.string().nullable(),
        status: z.string(),
        reason: z.string().nullable(),
        sentAt: z.string().nullable(),
        reminderSentAt: z.string().nullable(),
        clickedAt: z.string().nullable(),
        optedOutAt: z.string().nullable(),
      }),
    ),
  }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    const { c } = await loadCampaign(tx, actor, input.campaignId, "review:draft");
    const r = reviewRequestRecipients;
    const rows = await tx.select().from(r).where(eq(r.campaignId, c.id)).orderBy(r.createdAt, r.id).limit(input.limit).offset(input.offset);
    const [t] = await tx.select({ n: count() }).from(r).where(eq(r.campaignId, c.id));
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return {
      total: t?.n ?? 0,
      recipients: rows.map((x) => ({ id: x.id, email: x.email, name: x.name, status: x.status, reason: x.reason, sentAt: iso(x.sentAt), reminderSentAt: iso(x.reminderSentAt), clickedAt: iso(x.clickedAt), optedOutAt: iso(x.optedOutAt) })),
    };
  },
});
