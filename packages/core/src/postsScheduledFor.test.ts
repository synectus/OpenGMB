import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, posts, workspaces } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit } from "./testkit";
import { zonedWallToUtc } from "./time";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type Post = { id: string; status: string; scheduledFor: string | null };

describe("P1: the time picked in Compose is stored on the draft", () => {
  it("stores the UTC instant of a wall time in the client's zone, and clears or changes it", async () => {
    const org = await kit.makeOrg();
    await db.update(workspaces).set({ timeZone: "America/Chicago" }).where(eq(workspaces.id, org.a));
    const loc = await org.mkLoc(org.a);
    // The day before US clocks fall back (2027-11-07 02:00 CDT -> 01:00 CST): 09:30 is still CDT, UTC-5.
    const wall = "2027-11-06T09:30";
    const instant = zonedWallToUtc(wall, "America/Chicago")!;
    expect(instant.toISOString()).toBe("2027-11-06T14:30:00.000Z");
    const { post } = await kit.run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.row.id],
      topicType: "STANDARD",
      summary: "Open house.",
      scheduledFor: instant.toISOString(),
    });
    expect(post.scheduledFor).toBe("2027-11-06T14:30:00.000Z");
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row!.scheduledFor!.toISOString()).toBe("2027-11-06T14:30:00.000Z");
    // The day after the change the same wall time is CST, UTC-6.
    const after = zonedWallToUtc("2027-11-08T09:30", "America/Chicago")!;
    expect(after.toISOString()).toBe("2027-11-08T15:30:00.000Z");

    const moved = await kit.run<{ post: Post }>(org.manager, "posts.updateDraft", {
      id: post.id,
      scheduledFor: after.toISOString(),
    });
    expect(moved.post.scheduledFor).toBe("2027-11-08T15:30:00.000Z");
    const kept = await kit.run<{ post: Post }>(org.manager, "posts.updateDraft", {
      id: post.id,
      summary: "Open house, new text.",
    });
    expect(kept.post.scheduledFor).toBe("2027-11-08T15:30:00.000Z");
    const cleared = await kit.run<{ post: Post }>(org.manager, "posts.updateDraft", {
      id: post.id,
      scheduledFor: null,
    });
    expect(cleared.post.scheduledFor).toBeNull();
    expect((await kit.auditRows(org.orgId, "post.draft_updated")).length).toBe(3);
  });

  it("refuses a time in the past on create and on update", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      await codeOf(
        kit.run(org.manager, "posts.createDraft", {
          workspaceId: org.a,
          locationIds: [loc.row.id],
          topicType: "STANDARD",
          summary: "Open house.",
          scheduledFor: past,
        }),
      ),
    ).toBe("INVALID_INPUT");
    const { post } = await kit.run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.row.id],
      topicType: "STANDARD",
      summary: "Open house.",
    });
    expect(post.scheduledFor).toBeNull();
    expect(
      await codeOf(kit.run(org.manager, "posts.updateDraft", { id: post.id, scheduledFor: past })),
    ).toBe("INVALID_INPUT");
  });

  it("keeps the picked time through submit and approve, so the schedule form can prefill it", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const at = new Date(Date.now() + 2 * 86_400_000);
    at.setUTCSeconds(0, 0);
    const { post } = await kit.run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.row.id],
      topicType: "STANDARD",
      summary: "Open house.",
      scheduledFor: at.toISOString(),
    });
    await kit.run(org.manager, "posts.submit", { id: post.id, acknowledgeWarnings: true });
    const approved = await kit.run<{ post: Post }>(org.approverA, "posts.approve", { id: post.id });
    expect(approved.post.status).toBe("approved");
    expect(approved.post.scheduledFor).toBe(at.toISOString());
  });
});
