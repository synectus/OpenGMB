import { and, eq, isNull, sql } from "drizzle-orm";
import {
  locations,
  reviewLinks,
  reviewRequestCampaigns,
  reviewRequestOptouts,
  reviewRequestRecipients,
  type Db,
} from "@opengmb/db";
import { resolveReviewLink } from "../review-links/public";
import { workerAudit } from "../reviews/reply-state";
import { TOKEN_RE } from "./pure";

/**
 * The click link in a review request email. Returns Google's review form URL, or null for an unknown
 * token. A real click sets `clicked_at` (which cancels the reminder) and also counts as an "email"
 * open on the location's review link. Link scanners and previews (`isBot`) are redirected but never
 * counted, so they cannot cancel a reminder. No actor, no audit row: public and high volume.
 */
export async function openReviewRequestLink(
  db: Db,
  token: string,
  o: { isBot: boolean; now?: Date },
): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ id: reviewRequestRecipients.id, slug: reviewLinks.slug })
    .from(reviewRequestRecipients)
    .innerJoin(reviewRequestCampaigns, eq(reviewRequestCampaigns.id, reviewRequestRecipients.campaignId))
    .innerJoin(reviewLinks, eq(reviewLinks.locationId, reviewRequestCampaigns.locationId))
    .where(eq(reviewRequestRecipients.linkToken, token));
  if (!row) return null;
  if (!o.isBot) {
    const now = o.now ?? new Date();
    await db
      .update(reviewRequestRecipients)
      .set({ clickedAt: sql`coalesce(${reviewRequestRecipients.clickedAt}, ${now.toISOString()}::timestamptz)`, clickCount: sql`${reviewRequestRecipients.clickCount} + 1` })
      .where(eq(reviewRequestRecipients.id, row.id));
  }
  return resolveReviewLink(db, row.slug, { source: "email", count: !o.isBot, now: o.now });
}

/** What the unsubscribe page shows: the business name, or null for an unknown token. Does not change anything. */
export async function unsubscribeInfo(db: Db, token: string): Promise<{ business: string; alreadyOptedOut: boolean } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ name: locations.name, title: locations.title, optedOutAt: reviewRequestRecipients.optedOutAt })
    .from(reviewRequestRecipients)
    .innerJoin(reviewRequestCampaigns, eq(reviewRequestCampaigns.id, reviewRequestRecipients.campaignId))
    .innerJoin(locations, eq(locations.id, reviewRequestCampaigns.locationId))
    .where(eq(reviewRequestRecipients.linkToken, token));
  return row ? { business: row.title ?? row.name, alreadyOptedOut: Boolean(row.optedOutAt) } : null;
}

/**
 * Opts the address out for the whole client (workspace), forever: it is skipped by every campaign,
 * present and future. Marks every recipient row of that address in the client. Idempotent. The
 * audit row holds ids and a count, never the address.
 */
export async function unsubscribeReviewRequest(db: Db, token: string, now: Date = new Date()): Promise<"ok" | "invalid"> {
  if (!TOKEN_RE.test(token)) return "invalid";
  return db.transaction(async (tx) => {
    const [rec] = await tx.select().from(reviewRequestRecipients).where(eq(reviewRequestRecipients.linkToken, token));
    if (!rec) return "invalid" as const;
    await tx
      .insert(reviewRequestOptouts)
      .values({ orgId: rec.orgId, workspaceId: rec.workspaceId, email: rec.email })
      .onConflictDoNothing();
    const marked = await tx
      .update(reviewRequestRecipients)
      .set({ optedOutAt: now })
      .where(
        and(
          eq(reviewRequestRecipients.workspaceId, rec.workspaceId),
          eq(reviewRequestRecipients.email, rec.email),
          isNull(reviewRequestRecipients.optedOutAt),
        ),
      )
      .returning({ id: reviewRequestRecipients.id });
    if (marked.length > 0) {
      await workerAudit(tx, rec.orgId)({
        action: "review_request.opted_out",
        entityType: "review_request_recipient",
        entityId: rec.id,
        after: { workspaceId: rec.workspaceId, campaignId: rec.campaignId, recipientsMarked: marked.length },
      });
    }
    return "ok" as const;
  });
}
