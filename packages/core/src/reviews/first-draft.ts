import { and, desc, eq, sql } from "drizzle-orm";
import { locations, reviews, workspaces, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { replyStageSql } from "./reply-stage";
import { scopeConditions } from "./queries";

/** ON2: the newest review that needs a reply and that this actor may see, of any age (product decision, 2026-11-12). */
export async function newestReviewNeedingReply(tx: Tx, actor: Actor): Promise<string | null> {
  const [r] = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .innerJoin(locations, eq(locations.id, reviews.locationId))
    .innerJoin(workspaces, eq(workspaces.id, reviews.workspaceId))
    // The scope every review read uses; 'needs_reply' already honours skipPositiveReviews and not_wanted.
    .where(and(...scopeConditions(actor), sql`${replyStageSql} = 'needs_reply'`))
    .orderBy(desc(reviews.createTime), desc(reviews.id))
    .limit(1);
  return r?.id ?? null;
}
