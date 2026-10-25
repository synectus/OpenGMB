import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { GoogleApiError, MockGoogleClient } from "@opengmb/core";
import {
  auditLog,
  createDb,
  googleNotifications,
  locations,
  memberships,
  notifications,
  organizations,
  profileChanges,
  users,
  workspaces,
} from "@opengmb/db";
import { processGoogleNotification } from "./google-notification";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const created: string[] = [];
afterAll(async () => {
  for (const id of created)
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, id));
  await sql.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SECRET = "Call our new number to book a procedure";

async function world() {
  const n = uniq().replace(/\D/g, "");
  const locationName = `locations/6${n.slice(-10)}`;
  const mock = new MockGoogleClient();
  mock.addLocation({ name: locationName, title: "Watch Clinic" });
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
      name: "Watch Clinic",
      googleAccountName: "accounts/100000000000000000001",
      googleLocationId: locationName,
    })
    .returning();
  created.push(loc!.id);
  const uid = `u-${uniq()}`;
  await db.insert(users).values({ id: uid, name: "T", email: `${uid}@example.test` });
  await db.insert(memberships).values({ orgId: org!.id, userId: uid, role: "owner" });
  const gn = async () => {
    const [r] = await db
      .insert(googleNotifications)
      .values({
        orgId: org!.id,
        locationId: loc!.id,
        pubsubMessageId: `m-${uniq()}`,
        type: "GOOGLE_UPDATE",
        resourceName: null,
        locationName,
        payload: { notificationType: "GOOGLE_UPDATE" },
      })
      .returning();
    return r!.id;
  };
  return { org: org!.id, loc: loc!, locationName, uid, mock, gn };
}
const mine = (uid: string) => db.select().from(notifications).where(eq(notifications.userId, uid));
const changes = (locationId: string) =>
  db.select().from(profileChanges).where(eq(profileChanges.locationId, locationId));
const processed = async (id: string) =>
  (await db.select().from(googleNotifications).where(eq(googleNotifications.id, id)))[0]!
    .processedAt;

describe("GOOGLE_UPDATE push -> google_suggested profile change", () => {
  it("stores the suggestion and sends profile.changed INSTEAD of the generic notification, with no values", async () => {
    const w = await world();
    w.mock.suggestGoogleChange(w.locationName, { profile: { description: SECRET } }, ["profile"]);
    const id = await w.gn();
    await processGoogleNotification(db, id, { client: w.mock });

    const [c] = await changes(w.loc.id);
    expect(c).toMatchObject({
      googleSuggested: true,
      source: "push",
      status: "open",
      fieldPaths: ["description"],
    });
    expect((c!.after as { fields: { description: string } }).fields.description).toBe(SECRET);
    expect(await processed(id)).not.toBeNull();
    const notes = await mine(w.uid);
    expect(notes.map((n) => [n.kind, n.title])).toEqual([
      ["profile.changed", "Profile change at Watch Clinic"],
    ]);
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, w.org));
    expect(JSON.stringify([notes, audits.map((a) => a.after)])).not.toContain(SECRET);
    const gu = audits.find((a) => a.action === "notification.create");
    expect(gu!.after).toMatchObject({
      kind: "profile.changed",
      replacedBy: "profile.changed",
      profileChangeId: c!.id,
    });
  });

  it("the same suggestion pushed again stores nothing new and keeps the generic notification", async () => {
    const w = await world();
    w.mock.suggestGoogleChange(w.locationName, { websiteUri: "https://g.example.test" }, [
      "websiteUri",
    ]);
    await processGoogleNotification(db, await w.gn(), { client: w.mock });
    await processGoogleNotification(db, await w.gn(), { client: w.mock });
    expect(await changes(w.loc.id)).toHaveLength(1);
    expect((await mine(w.uid)).map((n) => n.kind).sort()).toEqual([
      "google.google_update",
      "profile.changed",
    ]);
  });

  it("no difference, an unknown location or a Google 4xx keeps the F10 generic notification", async () => {
    const w = await world();
    await processGoogleNotification(db, await w.gn(), { client: w.mock }); // nothing differs
    const w2 = await world();
    w2.mock.failNext(1, () => new GoogleApiError(403, {}), "getGoogleUpdated");
    await processGoogleNotification(db, await w2.gn(), { client: w2.mock });
    for (const x of [w, w2]) {
      expect(await changes(x.loc.id)).toEqual([]);
      expect((await mine(x.uid)).map((n) => n.kind)).toEqual(["google.google_update"]);
    }
  });

  it("a transient Google error throws (pg-boss retries) and leaves the notification unprocessed", async () => {
    const w = await world();
    w.mock.suggestGoogleChange(w.locationName, { websiteUri: "https://g2.example.test" }, [
      "websiteUri",
    ]);
    w.mock.failNext(1, () => new GoogleApiError(503, {}), "getGoogleUpdated");
    const id = await w.gn();
    await expect(processGoogleNotification(db, id, { client: w.mock })).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    expect(await processed(id)).toBeNull();
    expect(await mine(w.uid)).toEqual([]);
    await processGoogleNotification(db, id, { client: w.mock });
    expect(await processed(id)).not.toBeNull();
    expect(await changes(w.loc.id)).toHaveLength(1);
  });

  it("an inactive location does nothing", async () => {
    const w = await world();
    w.mock.suggestGoogleChange(w.locationName, { websiteUri: "https://g3.example.test" }, [
      "websiteUri",
    ]);
    await db
      .update(locations)
      .set({ status: "inactive" })
      .where(and(eq(locations.id, w.loc.id)));
    await processGoogleNotification(db, await w.gn(), { client: w.mock });
    expect(await changes(w.loc.id)).toEqual([]);
    expect(await mine(w.uid)).toEqual([]);
    expect(w.mock.callCount).toBe(0);
  });
});
