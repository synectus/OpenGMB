import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  MockGoogleClient,
  NEGATIVE_ALERT_MAX_AGE_DAYS,
  processReviewSync,
  recipientsForLocation,
} from "@opengmb/core";
import {
  auditLog,
  createDb,
  googleNotifications,
  locations,
  memberships,
  notifications,
  organizations,
  reviewSyncs,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { renderDigest } from "./digest";
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
const NAME = "Reviewer Rhonda";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function world() {
  const n = uniqDigits();
  const account = `accounts/7${n.slice(-8)}`;
  const locationName = `locations/7${n.slice(-10)}`;
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `w-${uniq()}` })
    .returning();
  const [wsOther] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `o-${uniq()}` })
    .returning();
  const [loc] = await db
    .insert(locations)
    .values({
      orgId: org!.id,
      workspaceId: ws!.id,
      name: "Alert Clinic",
      googleAccountName: account,
      googleLocationId: locationName,
      importedAt: new Date(),
    })
    .returning();
  const mk = async (role: "owner" | "manager" | "client_viewer", workspaceId: string | null) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role, workspaceId });
    return id;
  };
  const owner = await mk("owner", null);
  const manager = await mk("manager", null);
  const clientSame = await mk("client_viewer", ws!.id);
  const clientOther = await mk("client_viewer", wsOther!.id);
  const mock = new MockGoogleClient();
  const gn = async (type: "NEW_REVIEW" | "UPDATED_REVIEW", resourceName: string) => {
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
  const sync = async () => {
    const [s] = await db
      .insert(reviewSyncs)
      .values({ orgId: org!.id, locationId: loc!.id, requestedBy: null })
      .returning();
    await processReviewSync(db, s!.id, { client: mock });
  };
  return {
    org: org!.id,
    loc: loc!,
    account,
    locationName,
    owner,
    manager,
    clientSame,
    clientOther,
    mock,
    gn,
    sync,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const notes = (w: World) =>
  db
    .select()
    .from(notifications)
    .where(eq(notifications.orgId, w.org))
    .then((rows) => rows.sort((a, b) => a.userId.localeCompare(b.userId)));
const negatives = async (w: World) => (await notes(w)).filter((n) => n.kind === "review.negative");
const add = (w: World, init: Parameters<MockGoogleClient["addReview"]>[2]) =>
  w.mock.addReview(w.account, w.locationName, { comment: TEXT, reviewerName: NAME, ...init });

describe("R5 negative-review alerts", () => {
  it("Pub/Sub: a new 2-star raises exactly one review.negative per recipient and no generic notification", async () => {
    const w = await world();
    const name = add(w, { starRating: "TWO" });
    await processGoogleNotification(db, await w.gn("NEW_REVIEW", name), { client: w.mock });
    const all = await notes(w);
    expect(all.every((n) => n.kind === "review.negative")).toBe(true);
    expect(all.map((n) => n.userId).sort()).toEqual(
      [w.owner, w.manager, w.clientSame].sort(), // client of another workspace gets nothing
    );
    expect(all.map((n) => n.userId)).not.toContain(w.clientOther);
    const [row] = await db.select().from(reviews).where(eq(reviews.googleReviewName, name));
    for (const n of all) {
      expect(n.title).toBe("2★ review at Alert Clinic");
      expect(n.link).toBe(`/reviews?review=${row!.id}`);
      expect(n.sourceType).toBe("review");
      expect(n.sourceId).toBe(`${row!.id}:${row!.updateTime.toISOString()}`);
    }
    const blob = JSON.stringify(all);
    expect(blob).not.toContain("back pain");
    expect(blob).not.toContain(NAME);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, w.org), eq(auditLog.entityType, "review")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ surface: "worker", actorType: "system" });
    expect(audit[0]!.after).toEqual({ reviewId: row!.id, rating: 2, recipientCount: 3 });
    expect(
      JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.orgId, w.org))),
    ).not.toContain("back pain");
  });

  it("Pub/Sub: a new 5-star keeps only the generic F10 notification", async () => {
    const w = await world();
    const name = add(w, { starRating: "FIVE" });
    await processGoogleNotification(db, await w.gn("NEW_REVIEW", name), { client: w.mock });
    const all = await notes(w);
    expect(all).toHaveLength(3);
    expect(all.every((n) => n.kind === "google.new_review")).toBe(true);
  });

  it("Pub/Sub: updating 5-star to 2-star alerts even though the review existed; a later identical update does not", async () => {
    const w = await world();
    const name = add(w, { starRating: "FIVE" });
    await processGoogleNotification(db, await w.gn("NEW_REVIEW", name), { client: w.mock });
    w.mock.updateReview(name, {
      starRating: "TWO",
      updateTime: new Date(Date.now() + 60_000).toISOString(),
    });
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW", name), { client: w.mock });
    expect(await negatives(w)).toHaveLength(3);
    // 2 -> 1 is already negative: generic update notice only, no second alert
    w.mock.updateReview(name, {
      starRating: "ONE",
      updateTime: new Date(Date.now() + 120_000).toISOString(),
    });
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW", name), { client: w.mock });
    expect(await negatives(w)).toHaveLength(3);
    // a drop after a recovery alerts again (update time is part of source_id)
    w.mock.updateReview(name, {
      starRating: "FOUR",
      updateTime: new Date(Date.now() + 180_000).toISOString(),
    });
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW", name), { client: w.mock });
    w.mock.updateReview(name, {
      starRating: "ONE",
      updateTime: new Date(Date.now() + 240_000).toISOString(),
    });
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW", name), { client: w.mock });
    expect(await negatives(w)).toHaveLength(6);
  });

  it("sync: a 1-star created 3 days ago alerts; re-syncing it unchanged does not alert again", async () => {
    const w = await world();
    add(w, { starRating: "ONE", createTime: daysAgo(3) });
    await w.sync();
    expect(await negatives(w)).toHaveLength(3);
    const before = (await notes(w)).length;
    await w.sync();
    expect((await notes(w)).length).toBe(before);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, w.org), eq(auditLog.entityType, "review")));
    expect(audit).toHaveLength(1);
  });

  it("sync: a 1-star created 60 days ago in the initial sync does not alert (cutoff is configured)", async () => {
    expect(NEGATIVE_ALERT_MAX_AGE_DAYS).toBe(14);
    const w = await world();
    add(w, { starRating: "ONE", createTime: daysAgo(60) });
    add(w, { starRating: "TWO", createTime: daysAgo(NEGATIVE_ALERT_MAX_AGE_DAYS + 1) });
    await w.sync();
    expect(await notes(w)).toHaveLength(0);
    expect(await db.select().from(reviews).where(eq(reviews.locationId, w.loc.id))).toHaveLength(2);
  });

  it("sync: a review dropping from 5 to 2 stars alerts on the next sync", async () => {
    const w = await world();
    const name = add(w, { starRating: "FIVE", createTime: daysAgo(2) });
    await w.sync();
    expect(await notes(w)).toHaveLength(0);
    w.mock.updateReview(name, {
      starRating: "TWO",
      updateTime: new Date(Date.now() + 60_000).toISOString(),
    });
    await w.sync();
    expect(await negatives(w)).toHaveLength(3);
  });

  it("recipients are workspace-scoped (control: helper agrees)", async () => {
    const w = await world();
    const r = await db.transaction((tx) => recipientsForLocation(tx, w.org, w.loc.id));
    expect(r).not.toContain(w.clientOther);
  });

  it("the digest labels review.negative as negative reviews and carries no review text", () => {
    const d = renderDigest(
      [
        { kind: "review.negative", locationName: null },
        { kind: "review.negative", locationName: null },
        { kind: "google.new_review", locationName: "Alert Clinic" },
      ],
      "https://app.example.test",
    );
    expect(d.text).toContain("Negative reviews: 2");
    expect(d.html).toContain("Negative reviews: 2");
    expect(d.text).not.toContain("review.negative");
    expect(d.text + d.html).not.toContain("back pain");
  });
});
