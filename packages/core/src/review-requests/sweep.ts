import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  locations,
  reviewLinks,
  reviewRequestCampaigns,
  reviewRequestOptouts,
  reviewRequestRecipients,
  workspaces,
  type Db,
} from "@opengmb/db";
import { loadBranding } from "../branding";
import { emailFromFor } from "../custom-domains";
import { emailConfigured, getEmailSender, type SendEmail } from "../email";
import { LIST_SOURCES, MAX_SEND_ATTEMPTS, reviewRequestDailyLimit, reviewRequestWorkspaceDailyLimit, SWEEP_BATCH } from "../config/review-requests";
import { identityOf, sendingBlock } from "./identity";
import { appBaseUrl, buildReviewRequestEmail, clickUrl, inSendWindow, unsubscribeUrl } from "./pure";

const DAY = 86_400_000;

export type SweepResult = {
  sent: number;
  reminders: number;
  skipped: number;
  /** Candidates left for a later sweep because it was outside the client's sending hours. */
  outsideHours: number;
  /** Candidates left for later because their client reached its own 24 hour allowance. */
  throttled: number;
  /** Why nothing could be sent at all, if so. */
  blocked: "email_not_configured" | "no_base_url" | "daily_limit" | null;
};

/**
 * The worker sweep for review request emails. The database is the schedule (like the posts and
 * photo sweeps). Per run: stop if mail or the public URL is not configured, work out what is left of
 * the rolling 24 hour allowance (first sends and reminders, whole server), then take due recipients
 * oldest first. A recipient is due for a first email while `pending`, and for the one reminder when
 * sent at least `reminder_days` days ago with no click and no opt-out. Nothing is sent outside
 * 08:00 to 21:00 in the client's time zone. Each send runs under a row lock (SKIP LOCKED) with an
 * idempotency key, and the opt-out list is checked again right before every send. Legal batch B: a
 * client whose business is a HIPAA covered entity is skipped, a client without legal name and postal
 * address is left out (recipients stay pending until they are set), and each client has its own 24 hour allowance.
 */
export async function sweepReviewRequests(
  db: Db,
  deps: { now?: Date; send?: SendEmail; base?: string | null; dailyLimit?: number; workspaceDailyLimit?: number; batch?: number; orgIds?: string[] } = {},
): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const out: SweepResult = { sent: 0, reminders: 0, skipped: 0, outsideHours: 0, throttled: 0, blocked: null };
  if (!deps.send && !emailConfigured()) return { ...out, blocked: "email_not_configured" };
  const base = deps.base === undefined ? appBaseUrl() : deps.base;
  if (!base) return { ...out, blocked: "no_base_url" };
  const send = deps.send ?? getEmailSender();

  const since = new Date(now.getTime() - DAY);
  const [used] = await db
    .select({
      n: sql<number>`(count(*) filter (where ${reviewRequestRecipients.sentAt} > ${since.toISOString()}::timestamptz) + count(*) filter (where ${reviewRequestRecipients.reminderSentAt} > ${since.toISOString()}::timestamptz))::int`,
    })
    .from(reviewRequestRecipients);
  const capacity = Math.min((deps.dailyLimit ?? reviewRequestDailyLimit()) - (used?.n ?? 0), deps.batch ?? SWEEP_BATCH);
  if (capacity <= 0) return { ...out, blocked: "daily_limit" };

  // Per-client allowance (legal review Q37): clients already at their own limit are left out of this run.
  const wsLimit = deps.workspaceDailyLimit ?? reviewRequestWorkspaceDailyLimit();
  const wsUsedRows = await db
    .select({
      workspaceId: reviewRequestRecipients.workspaceId,
      n: sql<number>`(count(*) filter (where ${reviewRequestRecipients.sentAt} > ${since.toISOString()}::timestamptz) + count(*) filter (where ${reviewRequestRecipients.reminderSentAt} > ${since.toISOString()}::timestamptz))::int`,
    })
    .from(reviewRequestRecipients)
    .groupBy(reviewRequestRecipients.workspaceId);
  const wsUsed = new Map(wsUsedRows.map((r) => [r.workspaceId, r.n]));
  const atLimit = wsUsedRows.filter((r) => r.n >= wsLimit).map((r) => r.workspaceId);

  const due = await db
    .select({ id: reviewRequestRecipients.id, orgId: reviewRequestRecipients.orgId, workspaceId: reviewRequestRecipients.workspaceId, tz: workspaces.timeZone })
    .from(reviewRequestRecipients)
    .innerJoin(reviewRequestCampaigns, eq(reviewRequestCampaigns.id, reviewRequestRecipients.campaignId))
    .innerJoin(workspaces, eq(workspaces.id, reviewRequestRecipients.workspaceId))
    .where(
      and(
        eq(reviewRequestCampaigns.status, "active"),
        // A client without legal name and postal address sends nothing; its recipients stay pending until they are set.
        isNotNull(workspaces.senderLegalName),
        isNotNull(workspaces.senderPostalAddress),
        atLimit.length ? notInArray(reviewRequestRecipients.workspaceId, atLimit) : undefined,
        deps.orgIds ? inArray(reviewRequestRecipients.orgId, deps.orgIds) : undefined,
        or(
          and(eq(reviewRequestRecipients.status, "pending"), lt(reviewRequestRecipients.attempts, MAX_SEND_ATTEMPTS)),
          and(
            eq(reviewRequestRecipients.status, "sent"),
            eq(reviewRequestCampaigns.reminderEnabled, true),
            isNull(reviewRequestRecipients.reminderSentAt),
            isNull(reviewRequestRecipients.reminderFailedAt),
            isNull(reviewRequestRecipients.clickedAt),
            isNull(reviewRequestRecipients.optedOutAt),
            isNotNull(reviewRequestRecipients.sentAt),
            sql`${reviewRequestRecipients.sentAt} + (${reviewRequestCampaigns.reminderDays} * interval '1 day') <= ${now.toISOString()}::timestamptz`,
          ),
        ),
      ),
    )
    .orderBy(reviewRequestRecipients.createdAt, reviewRequestRecipients.id)
    .limit(capacity * 4);

  const brands = new Map<string, Awaited<ReturnType<typeof loadBranding>>>();
  let budget = capacity;
  for (const cand of due) {
    if (budget <= 0) break;
    if (!inSendWindow(now, cand.tz)) {
      out.outsideHours++;
      continue;
    }
    if ((wsUsed.get(cand.workspaceId) ?? 0) >= wsLimit) {
      out.throttled++;
      continue;
    }
    const r = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ r: reviewRequestRecipients, c: reviewRequestCampaigns, loc: locations, ws: workspaces })
        .from(reviewRequestRecipients)
        .innerJoin(reviewRequestCampaigns, eq(reviewRequestCampaigns.id, reviewRequestRecipients.campaignId))
        .innerJoin(locations, eq(locations.id, reviewRequestCampaigns.locationId))
        .innerJoin(workspaces, eq(workspaces.id, reviewRequestRecipients.workspaceId))
        .where(eq(reviewRequestRecipients.id, cand.id))
        .for("update", { of: reviewRequestRecipients, skipLocked: true });
      if (!row || row.c.status !== "active") return "none" as const;
      const { r: rec, c: camp, loc, ws } = row;
      const reminder = rec.status === "sent";
      if (rec.status !== "pending" && !reminder) return "none" as const;
      if (reminder && (rec.reminderSentAt || rec.reminderFailedAt || rec.clickedAt || rec.optedOutAt)) return "none" as const;
      const stop = async (reason: string) => {
        if (reminder) await tx.update(reviewRequestRecipients).set({ reminderFailedAt: now }).where(eq(reviewRequestRecipients.id, rec.id));
        else await tx.update(reviewRequestRecipients).set({ status: "skipped", reason }).where(eq(reviewRequestRecipients.id, rec.id));
        return "skipped" as const;
      };
      const block = sendingBlock(ws);
      if (block?.reason === "hipaa") return stop("hipaa");
      if (block) return "none" as const;
      const [optout] = await tx
        .select({ id: reviewRequestOptouts.id })
        .from(reviewRequestOptouts)
        .where(and(eq(reviewRequestOptouts.workspaceId, rec.workspaceId), eq(reviewRequestOptouts.email, rec.email)));
      if (optout) {
        await tx.update(reviewRequestRecipients).set({ optedOutAt: rec.optedOutAt ?? now }).where(eq(reviewRequestRecipients.id, rec.id));
        return stop("opted_out");
      }
      const [link] = await tx.select({ id: reviewLinks.id }).from(reviewLinks).where(eq(reviewLinks.locationId, loc.id));
      if (!link || loc.status !== "active") return stop("no_review_link");
      let brand = brands.get(rec.orgId);
      if (!brand) {
        brand = await loadBranding(tx, rec.orgId);
        brands.set(rec.orgId, brand);
      }
      const mail = buildReviewRequestEmail({
        subject: camp.subject,
        body: camp.body,
        business: loc.title ?? loc.name,
        sender: identityOf(ws),
        listPhrase: rec.listSource && rec.listSource in LIST_SOURCES ? LIST_SOURCES[rec.listSource as keyof typeof LIST_SOURCES].phrase : null,
        listDate: rec.listConfirmedAt,
        recipientName: rec.name,
        brand,
        clickUrl: clickUrl(base, rec.linkToken),
        unsubscribeUrl: unsubscribeUrl(base, rec.linkToken),
        reminder,
      });
      try {
        await send({
          from: await emailFromFor(tx, rec.orgId),
          to: rec.email,
          ...mail,
          idempotencyKey: `review-request:${rec.id}:${reminder ? "reminder" : "initial"}`,
        });
      } catch (e) {
        console.error(`[review-requests] send failed for recipient ${rec.id}`, e instanceof Error ? e.message : e);
        if (reminder) {
          const attempts = rec.reminderAttempts + 1;
          await tx
            .update(reviewRequestRecipients)
            .set({ reminderAttempts: attempts, ...(attempts >= MAX_SEND_ATTEMPTS ? { reminderFailedAt: now } : {}) })
            .where(eq(reviewRequestRecipients.id, rec.id));
        } else {
          const attempts = rec.attempts + 1;
          await tx
            .update(reviewRequestRecipients)
            .set({ attempts, ...(attempts >= MAX_SEND_ATTEMPTS ? { status: "failed", reason: "send_failed" } : {}) })
            .where(eq(reviewRequestRecipients.id, rec.id));
        }
        return "failed" as const;
      }
      await tx
        .update(reviewRequestRecipients)
        .set(reminder ? { reminderSentAt: now } : { status: "sent", sentAt: now })
        .where(eq(reviewRequestRecipients.id, rec.id));
      return reminder ? ("reminder" as const) : ("initial" as const);
    });
    if (r === "initial") out.sent++;
    else if (r === "reminder") out.reminders++;
    else if (r === "skipped") out.skipped++;
    if (r === "initial" || r === "reminder" || r === "failed") {
      budget--;
      wsUsed.set(cand.workspaceId, (wsUsed.get(cand.workspaceId) ?? 0) + 1);
    }
  }
  return out;
}
