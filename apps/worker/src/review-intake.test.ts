import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MockGoogleClient } from "@opengmb/core";
import {
  auditLog,
  createDb,
  googleNotifications,
  locations,
  memberships,
  notifications,
  organizations,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { processGoogleNotification } from "./google-notification";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Digits only, for Google ids (`locations/7<digits>`): the timestamp plus 9 random digits, so two files
// minting an id in the same millisecond cannot collide (stripping letters from uniq() could).
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
const TEXT = "my back pain was ignored by Dr Smith";

async function world(status: "active" | "inactive" = "active") {
  const n = uniqDigits();
  const account = `accounts/8${n.slice(-8)}`;
  const locationName = `locations/8${n.slice(-10)}`;
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `w-${uniq()}` })
    .returning();
  const [loc] = await db
    .insert(locations)
    .values({
      orgId: org!.id,
      workspaceId: ws!.id,
      name: "Intake Clinic",
      googleAccountName: account,
      googleLocationId: locationName,
      status,
    })
    .returning();
  const uid = `u-${uniq()}`;
  await db.insert(users).values({ id: uid, name: "T", email: `${uid}@example.test` });
  await db.insert(memberships).values({ orgId: org!.id, userId: uid, role: "owner" });
  const mock = new MockGoogleClient();
  const gn = async (
    type: "NEW_REVIEW" | "UPDATED_REVIEW" | "GOOGLE_UPDATE",
    resourceName: string | null,
  ) => {
    const [r] = await db
      .insert(googleNotifications)
      .values({
        orgId: org!.id,
        locationId: loc!.id,
        pubsubMessageId: `m-${uniq()}`,
        type,
        resourceName,
        locationName,
        payload: { notificationType: type },
      })
      .returning();
    return r!.id;
  };
  return { org: org!.id, ws: ws!.id, loc: loc!, account, locationName, uid, mock, gn };
}

const reviewRows = (locationId: string) =>
  db.select().from(reviews).where(eq(reviews.locationId, locationId));
const processed = async (id: string) =>
  (await db.select().from(googleNotifications).where(eq(googleNotifications.id, id)))[0]!
    .processedAt;

describe("Pub/Sub review intake", () => {
  it("NEW_REVIEW fetches the review, upserts it, marks processed and (negative) raises only the R5 alert", async () => {
    const w = await world();
    const name = w.mock.addReview(w.account, w.locationName, {
      starRating: "FIVE",
      comment: TEXT,
      reviewerName: "Pat Q",
    });
    const id = await w.gn("NEW_REVIEW", name);
    await processGoogleNotification(db, id, { client: w.mock });

    const rows = await reviewRows(w.loc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      googleReviewName: name,
      orgId: w.org,
      workspaceId: w.ws,
      starRating: 5,
      comment: TEXT,
      reviewerDisplayName: "Pat Q",
      replyComment: null,
    });
    expect(await processed(id)).not.toBeNull();
    const notes = await db.select().from(notifications).where(eq(notifications.userId, w.uid));
    expect(notes.map((n) => n.title)).toEqual(["New review at Intake Clinic"]);
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, w.org),
          eq(auditLog.action, "notification.create"),
          eq(auditLog.entityType, "google_notification"),
        ),
      );
    expect(audit[0]!.after).toMatchObject({ review: { inserted: 1, updated: 0 } });
    expect(JSON.stringify(audit) + JSON.stringify(notes)).not.toContain("back pain");
    expect(w.mock.calls.map((c) => c.method)).toEqual(["getReview"]);

    // redelivery: nothing more happens, no second Google call
    await processGoogleNotification(db, id, { client: w.mock });
    expect(w.mock.callCount).toBe(1);
    expect(await reviewRows(w.loc.id)).toHaveLength(1);
  });

  it("UPDATED_REVIEW updates the stored row, including a reply made in the Google UI", async () => {
    const w = await world();
    const name = w.mock.addReview(w.account, w.locationName, { starRating: "ONE", comment: "bad" });
    await processGoogleNotification(db, await w.gn("NEW_REVIEW", name), { client: w.mock });
    w.mock.updateReview(name, {
      starRating: "THREE",
      comment: "better now",
      reply: "Sorry about that",
    });
    const id = await w.gn("UPDATED_REVIEW", name);
    await processGoogleNotification(db, id, { client: w.mock });
    const rows = await reviewRows(w.loc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      starRating: 3,
      comment: "better now",
      replyComment: "Sorry about that",
    });
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "notification.create")));
    expect(audit[0]!.after).toMatchObject({ review: { inserted: 0, updated: 1 } });
  });

  it("a failed getReview throws, leaves processed_at null and changes nothing; the retry succeeds", async () => {
    const w = await world();
    const name = w.mock.addReview(w.account, w.locationName, { comment: TEXT });
    const id = await w.gn("NEW_REVIEW", name);
    w.mock.failNext(1, () => new Error("google down"));
    await expect(processGoogleNotification(db, id, { client: w.mock })).rejects.toThrow(
      "google down",
    );
    expect(await processed(id)).toBeNull();
    expect(await reviewRows(w.loc.id)).toHaveLength(0);
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, w.uid)),
    ).toHaveLength(0);

    await processGoogleNotification(db, id, { client: w.mock });
    expect(await processed(id)).not.toBeNull();
    expect(await reviewRows(w.loc.id)).toHaveLength(1);
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, w.uid)),
    ).toHaveLength(1);
  });

  it("an inactive location is marked processed and nothing is fetched, stored or notified", async () => {
    const w = await world("inactive");
    const name = w.mock.addReview(w.account, w.locationName, {});
    const id = await w.gn("NEW_REVIEW", name);
    await processGoogleNotification(db, id, { client: w.mock });
    expect(await processed(id)).not.toBeNull();
    expect(w.mock.callCount).toBe(0);
    expect(await reviewRows(w.loc.id)).toHaveLength(0);
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, w.uid)),
    ).toHaveLength(0);
  });

  it("GOOGLE_UPDATE, a review name from another location, and a review Google no longer has all skip the fetch or the upsert but keep F10", async () => {
    const w = await world();
    await processGoogleNotification(db, await w.gn("GOOGLE_UPDATE", null), { client: w.mock });
    // GOOGLE_UPDATE reads what Google shows (getGoogleUpdated; nothing differs here) and no review.
    expect(w.mock.calls.map((c) => c.method)).toEqual(["getGoogleUpdated"]);
    const foreign = `accounts/1/locations/999/reviews/x`;
    await processGoogleNotification(db, await w.gn("NEW_REVIEW", foreign), { client: w.mock });
    expect(w.mock.callCount).toBe(1);
    const gone = `${w.account}/${w.locationName}/reviews/gone`;
    const id = await w.gn("UPDATED_REVIEW", gone);
    await processGoogleNotification(db, id, { client: w.mock }); // mock answers NOT_FOUND
    expect(w.mock.callCount).toBe(2);
    expect(await processed(id)).not.toBeNull();
    expect(await reviewRows(w.loc.id)).toHaveLength(0);
    const titles = (
      await db.select().from(notifications).where(eq(notifications.userId, w.uid))
    ).map((n) => n.title);
    expect(titles.sort()).toEqual([
      "Google suggested an edit to Intake Clinic",
      "New review at Intake Clinic",
      "Updated review at Intake Clinic",
    ]);
  });
});
