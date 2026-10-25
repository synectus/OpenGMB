import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, reviewReplies, reviews, workspaceReplySettings } from "@opengmb/db";
import { MockGoogleClient } from "../google/mock-client";
import { makeKit, uniq, type Loc, type Org } from "../testkit";
import { eq } from "drizzle-orm";
import {
  REPLY_STAGES,
  replyStageOf,
  replyStageSql,
  needsYouSql,
  waitingToPublishSql,
  type OpenReplyStatus,
  type ReplyStage,
} from "./reply-stage";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
afterAll(async () => {
  await kit.deactivateAll();
  await pg.end();
});

let seq = 0;
export async function seedReview(
  org: Org,
  loc: Loc,
  o: { rating?: number | null; reply?: string | null; replyState?: string | null; open?: OpenReplyStatus } = {},
) {
  const at = new Date(Date.UTC(2026, 9, 1, 9, seq % 60));
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.row.orgId,
      workspaceId: loc.row.workspaceId,
      locationId: loc.row.id,
      googleReviewName: `${loc.parent}/reviews/${uniq()}-${seq++}`,
      starRating: o.rating === undefined ? 2 : o.rating,
      comment: "Waited too long.",
      createTime: at,
      updateTime: at,
      replyComment: o.reply ?? null,
      replyState: o.replyState ?? null,
    })
    .returning();
  if (o.open)
    await db.insert(reviewReplies).values({
      orgId: r!.orgId,
      workspaceId: r!.workspaceId,
      reviewId: r!.id,
      revision: 1,
      body: "Thank you for telling us.",
      status: o.open,
      createdBy: org.ownerId,
      createdSurface: "ui",
      submittedAt: o.open === "draft" ? null : new Date(),
      approvedAt: o.open === "approved" ? new Date() : null,
      approvedBy: o.open === "approved" ? org.ownerId : null,
    });
  return r!;
}

const stageOfRow = async (id: string) =>
  (await db.select({ s: replyStageSql }).from(reviews).where(eq(reviews.id, id)))[0]!.s;

describe("reply stage", () => {
  it("the audit case: an approved reply that is not published is waiting_publish, not needs-you", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const r = await seedReview(org, loc, { open: "approved" });
    expect(await stageOfRow(r.id)).toBe("waiting_publish");
    const [row] = await db
      .select({ needsYou: needsYouSql, waiting: waitingToPublishSql })
      .from(reviews)
      .where(eq(reviews.id, r.id));
    expect(row).toEqual({ needsYou: false, waiting: true });
  });

  it("SQL and the JS twin agree on every combination (canary: all 8 stages are reached)", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    await db.insert(workspaceReplySettings).values({ workspaceId: org.b, orgId: org.orgId, skipPositiveReviews: true });
    const locB = await org.mkLoc(org.b);
    const seen = new Set<ReplyStage>();
    const opens: (OpenReplyStatus | undefined)[] = [undefined, "draft", "pending_approval", "approved", "blocked", "failed"];
    const replies = [
      { reply: null, replyState: null },
      { reply: "Thanks", replyState: "APPROVED" },
      { reply: "Thanks", replyState: "REJECTED" },
    ];
    let n = 0;
    for (const skip of [false, true])
      for (const rating of [1, 5, null])
        for (const rep of replies)
          for (const open of opens) {
            const r = await seedReview(org, skip ? locB : loc, { rating, ...rep, open });
            const sqlStage = await stageOfRow(r.id);
            const js = replyStageOf({
              replyComment: rep.reply,
              replyState: rep.replyState,
              starRating: rating,
              openStatus: open ?? null,
              skipPositiveReviews: skip,
            });
            expect(sqlStage, JSON.stringify({ skip, rating, rep, open })).toBe(js);
            seen.add(js);
            n++;
          }
    expect(n).toBe(108);
    expect([...seen].sort()).toEqual([...REPLY_STAGES].sort());
  });
});
