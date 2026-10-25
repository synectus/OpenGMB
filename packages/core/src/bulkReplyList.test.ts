import { afterAll, describe, expect, it } from "vitest";
import { reviewReplies, reviews } from "@opengmb/db";
import type { Actor } from "./actor";
import { executeAction } from "./executor";
import { codeOf, db, makeOrg, sql, uniq, type Org } from "./performance-fixture";

type Item = {
  id: string;
  replyAllowed: boolean;
  skipReason: string | null;
  openReply: { id: string; status: string } | null;
};
type Out = { items: Item[]; nextCursor: string | null };

const unreplied = (actor: Actor, input: Record<string, unknown> = {}) =>
  executeAction(db, actor, "reviews.list_unreplied", { limit: 100, ...input }) as Promise<Out>;

let seq = 0;
async function mkReview(o: Org, locationId: string, workspaceId: string, rating: number, day: string) {
  const at = new Date(`${day}T10:00:00Z`);
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: o.orgId,
      workspaceId,
      locationId,
      googleReviewName: `accounts/1/locations/1/reviews/${uniq()}-${seq++}`,
      reviewerDisplayName: "Pat",
      starRating: rating,
      comment: "Fine",
      createTime: at,
      updateTime: at,
    })
    .returning();
  return r!;
}

afterAll(async () => {
  await sql.end();
});

describe("reviews.list_unreplied filters and openReply", () => {
  it("filters by workspace, location and rating", async () => {
    const o = await makeOrg();
    const a1 = await mkReview(o, o.locA1.id, o.wsA, 2, "2026-09-01");
    const a2 = await mkReview(o, o.locA2.id, o.wsA, 5, "2026-09-02");
    const b = await mkReview(o, o.locB.id, o.wsB, 1, "2026-09-03");

    const all = (await unreplied(o.owner)).items.map((i) => i.id);
    expect(all).toEqual(expect.arrayContaining([a1.id, a2.id, b.id]));

    const ws = (await unreplied(o.owner, { workspaceId: o.wsA })).items.map((i) => i.id);
    expect(ws.sort()).toEqual([a1.id, a2.id].sort());

    const loc = (await unreplied(o.owner, { locationIds: [o.locA2.id] })).items.map((i) => i.id);
    expect(loc).toEqual([a2.id]);

    const low = (await unreplied(o.owner, { ratings: [1, 2, 3] })).items.map((i) => i.id);
    expect(low.sort()).toEqual([a1.id, b.id].sort());
  });

  it("refuses a workspace the caller cannot read", async () => {
    const o = await makeOrg();
    await mkReview(o, o.locB.id, o.wsB, 3, "2026-09-04");
    expect(await codeOf(unreplied(o.viewerA, { workspaceId: o.wsB }))).not.toBe("no error");
  });

  it("marks a review with an open draft as not replyAllowed, with the open reply", async () => {
    const o = await makeOrg();
    const r = await mkReview(o, o.locA1.id, o.wsA, 2, "2026-09-05");
    const free = await mkReview(o, o.locA1.id, o.wsA, 2, "2026-09-06");
    const [draft] = await db
      .insert(reviewReplies)
      .values({
        orgId: o.orgId,
        workspaceId: o.wsA,
        reviewId: r.id,
        revision: 1,
        body: "Thanks.",
        status: "draft",
        createdBy: o.owner.userId,
        createdSurface: "ui",
      })
      .returning();

    const out = await unreplied(o.owner, { includeSkipped: true });
    const item = out.items.find((i) => i.id === r.id)!;
    expect(item.replyAllowed).toBe(false);
    expect(item.skipReason).toContain("already in progress");
    expect(item.openReply).toEqual({ id: draft!.id, status: "draft" });
    const other = out.items.find((i) => i.id === free.id)!;
    expect(other).toMatchObject({ replyAllowed: true, skipReason: null, openReply: null });

    const hidden = await unreplied(o.owner);
    expect(hidden.items.map((i) => i.id)).not.toContain(r.id);
    expect(hidden.items.map((i) => i.id)).toContain(free.id);
  });
});
