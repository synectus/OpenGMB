// OPS3: permanent Google failures settle at once instead of retrying, and the customer's lost access is flagged.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, googleConnections, locations, memberships, notifications, reviewSyncs, users } from "@opengmb/db";
import { encryptSecret } from "../crypto";
import { ensureQueues } from "../jobs";
import { enqueueScheduledReviewSyncs, processReviewMirror, processReviewSync, REVIEW_SYNC_QUEUE } from "../reviews/sync";
import { runNotificationRegistration } from "./notification-registration";
import { makeKit } from "../testkit";
import { GOOGLE_ACCESS_LOST_KIND, markGoogleAccessLost } from "./access-lost";
import { GoogleApiError, isGoogleAccessLost, isGoogleNotFound } from "./errors";
import { createGoogleClient } from "./factory";
import { MockGoogleClient } from "./mock-client";
import { setGoogleOAuthOverrides } from "./oauth";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
let mode: string | undefined;
let org: Awaited<ReturnType<typeof kit.makeOrg>>;
let connectionId: string;
let adminId: string;

const tokenFake = (res: { status: number; body: unknown }) =>
  setGoogleOAuthOverrides({
    clientId: "c",
    clientSecret: "s",
    tokenUrl: "http://token.test/token",
    fetch: (async () => new Response(JSON.stringify(res.body), { status: res.status })) as typeof fetch,
  });

beforeAll(async () => {
  mode = process.env.GOOGLE_BUSINESS_API_MODE;
  await ensureQueues(url!, [REVIEW_SYNC_QUEUE]);
  org = await kit.makeOrg();
  adminId = `u-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: adminId, name: "A", email: `${adminId}@example.test` });
  await db.insert(memberships).values({ orgId: org.orgId, userId: adminId, role: "admin" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PUBSUB_TOPIC;
  setGoogleOAuthOverrides({});
  if (mode === undefined) delete process.env.GOOGLE_BUSINESS_API_MODE;
  else process.env.GOOGLE_BUSINESS_API_MODE = mode;
});
afterAll(async () => {
  await kit.deactivateAll();
  await client.end();
});

/** A fresh active location of the org and a pending sync for it. */
async function pendingSync() {
  const loc = await org.mkLoc(org.a);
  connectionId = loc.row.connectionId!;
  await db
    .update(googleConnections)
    .set({ refreshTokenEnc: encryptSecret("rt"), accessLostAt: null })
    .where(eq(googleConnections.id, connectionId));
  const out = (await kit.run(org.owner, "reviews.sync", { workspaceId: org.a })) as { syncs: { syncId: string; locationId: string }[] };
  return { loc, syncId: out.syncs.find((s) => s.locationId === loc.row.id)!.syncId };
}
const syncRow = async (id: string) => (await db.select().from(reviewSyncs).where(eq(reviewSyncs.id, id)))[0]!;
const lostAt = async () => (await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId)))[0]!.accessLostAt;

describe("error classification", () => {
  it("tells a lost grant from a 404 and from a transient failure", () => {
    expect(isGoogleNotFound(new GoogleApiError(404, {}))).toBe(true);
    expect(isGoogleNotFound(new GoogleApiError(500, {}))).toBe(false);
    expect(isGoogleAccessLost(new GoogleApiError(404, {}))).toBe(false);
    expect(isGoogleAccessLost(new Error("x"))).toBe(false);
  });
});

describe("reviews.sync with permanent Google failures", () => {
  it("404 on listReviews settles failed google_location_not_found, does not throw, keeps the location active", async () => {
    const { loc, syncId } = await pendingSync();
    const notFound = Object.assign(Object.create(mock), {
      listReviews: async () => {
        throw new GoogleApiError(404, { error: { status: "NOT_FOUND" } }, "Google API error 404: Requested entity was not found.");
      },
    }) as MockGoogleClient;
    expect(await processReviewSync(db, syncId, { client: notFound, isFinalAttempt: false })).toBeNull();
    expect(await syncRow(syncId)).toMatchObject({ status: "failed", error: "google_location_not_found" });
    const [l] = await db.select().from(locations).where(eq(locations.id, loc.row.id));
    expect(l!.status).toBe("active");
    expect(await lostAt()).toBeNull();
  });

  it("invalid_grant flags the connection, settles failed google_access_lost, does not throw, notifies owners once; the fan-out then skips it", async () => {
    const { loc, syncId } = await pendingSync();
    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    tokenFake({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    expect(await processReviewSync(db, syncId, { isFinalAttempt: false })).toBeNull();
    expect(await syncRow(syncId)).toMatchObject({ status: "failed", error: "google_access_lost" });
    expect(await lostAt()).toBeInstanceOf(Date);

    const note = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.orgId, org.orgId), eq(notifications.kind, GOOGLE_ACCESS_LOST_KIND)));
    // Owner and admin hear about it; the manager, approvers and viewer in the same org do not.
    expect(note.map((n) => n.userId).sort()).toEqual([org.ownerId, adminId].sort());
    expect(note[0]!.link).toBe("/settings/google");
    const [c] = await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId));
    expect(note[0]!.title).toContain(c!.googleAccountEmail); // names the Google account that lost access

    // A second failure keeps the first timestamp and sends no second notification.
    const first = await lostAt();
    const again = await pendingSync(); // resets the flag; re-fail by hand below
    await db.update(googleConnections).set({ accessLostAt: first }).where(eq(googleConnections.id, connectionId));
    expect(await processReviewSync(db, again.syncId, { isFinalAttempt: false })).toBeNull();
    expect(await lostAt()).toEqual(first);
    expect(
      await db.select().from(notifications).where(and(eq(notifications.orgId, org.orgId), eq(notifications.kind, GOOGLE_ACCESS_LOST_KIND))),
    ).toHaveLength(2); // owner + admin, once

    // The fan-out leaves every location of the lost connection alone...
    await db.update(reviewSyncs).set({ status: "failed" }).where(eq(reviewSyncs.locationId, loc.row.id));
    const r = await enqueueScheduledReviewSyncs(db, { orgIds: [org.orgId] });
    expect(r.locations).toBe(0);
    // ...but a user-triggered sync still queues.
    const manual = (await kit.run(org.owner, "reviews.sync", { workspaceId: org.a })) as { syncs: unknown[] };
    expect(manual.syncs.length).toBeGreaterThan(0);
  });

  it("a non-permanent failure still throws and stays pending for the retry", async () => {
    const { syncId } = await pendingSync();
    const down = Object.assign(Object.create(mock), {
      listReviews: async () => {
        throw new GoogleApiError(500, null);
      },
    }) as MockGoogleClient;
    await expect(processReviewSync(db, syncId, { client: down, isFinalAttempt: false })).rejects.toThrow(/500/);
    expect((await syncRow(syncId)).status).toBe("pending");
    // The last attempt marks it failed with the old reason.
    await expect(processReviewSync(db, syncId, { client: down, isFinalAttempt: true })).rejects.toThrow(/500/);
    expect(await syncRow(syncId)).toMatchObject({ status: "failed", error: "google_fetch_failed" });
  });

  it("a non-invalid_grant refresh failure (e.g. temporarily_unavailable) is not access loss", async () => {
    const { syncId } = await pendingSync();
    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    tokenFake({ status: 400, body: { error: "temporarily_unavailable" } });
    await expect(processReviewSync(db, syncId, { isFinalAttempt: false })).rejects.toThrow(/token refresh failed/);
    expect(await lostAt()).toBeNull();
    expect((await syncRow(syncId)).status).toBe("pending");
  });
});

describe("clearing the flag", () => {
  it("a successful token refresh clears it (no real network: fetch is stubbed)", async () => {
    await pendingSync();
    await db.update(googleConnections).set({ accessLostAt: new Date() }).where(eq(googleConnections.id, connectionId));
    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    tokenFake({ status: 200, body: { access_token: "at", expires_in: 3600 } });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    const [conn] = await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId));
    await createGoogleClient({ db, connection: conn! }).listAccounts();
    expect(await lostAt()).toBeNull();
  });
});

describe("a late failure of an old token", () => {
  it("does not flag a connection that was reconnected meanwhile, and sends no second notification", async () => {
    await pendingSync();
    const [oldConn] = await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId));
    const count = async () =>
      (await db.select().from(notifications).where(and(eq(notifications.orgId, org.orgId), eq(notifications.kind, GOOGLE_ACCESS_LOST_KIND)))).length;
    const before = await count();
    // Reconnect: new stored token, flag cleared.
    await db.update(googleConnections).set({ refreshTokenEnc: encryptSecret("rt-new"), accessLostAt: null }).where(eq(googleConnections.id, connectionId));
    // A refresh that started with the OLD token fails now.
    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    tokenFake({ status: 400, body: { error: "invalid_grant" } });
    await createGoogleClient({ db, connection: oldConn! }).listAccounts().catch(() => undefined);
    expect(await lostAt()).toBeNull();
    expect(await markGoogleAccessLost(db, connectionId, oldConn!.refreshTokenEnc)).toBe(false);
    expect(await count()).toBe(before);
    // The current token does flag it.
    const [cur] = await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId));
    expect(await markGoogleAccessLost(db, connectionId, cur!.refreshTokenEnc)).toBe(true);
  });
});

describe("daily notification registration is the probe for a lost connection", () => {
  it("still lost: no throw, flag and timestamp kept, no second notification; accepted again: the flag clears", async () => {
    await pendingSync();
    process.env.PUBSUB_TOPIC = "projects/p/topics/t";
    const stamp = new Date("2026-01-01T00:00:00Z");
    await db.update(googleConnections).set({ accessLostAt: stamp }).where(eq(googleConnections.id, connectionId));
    const notes = async () =>
      (await db.select().from(notifications).where(and(eq(notifications.orgId, org.orgId), eq(notifications.kind, GOOGLE_ACCESS_LOST_KIND)))).length;
    const before = await notes();
    process.env.GOOGLE_BUSINESS_API_MODE = "live";
    tokenFake({ status: 400, body: { error: "invalid_grant" } });
    const r = await runNotificationRegistration(db, { connectionId, scope: "all" });
    expect(r.failed).toBe(1); // it did try (the connection is not skipped)
    expect((await db.select().from(googleConnections).where(eq(googleConnections.id, connectionId)))[0]!.accessLostAt).toEqual(stamp);
    expect(await notes()).toBe(before);

    tokenFake({ status: 200, body: { access_token: "at", expires_in: 3600 } });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    await runNotificationRegistration(db, { connectionId, scope: "all" });
    expect(await lostAt()).toBeNull();
  });
});

describe("reviews.mirror_sync", () => {
  it("skips (and says why) when posts hit a Google 404 or lost access instead of failing the job", async () => {
    const { loc } = await pendingSync();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gone = { listLocalPosts: async () => { throw new GoogleApiError(404, {}); } };
    expect(await processReviewMirror(db, { locationId: loc.row.id, step: "posts" }, { client: gone })).toBe("skipped");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${loc.row.id} posts skipped: google_location_not_found`));
    const other = { listLocalPosts: async () => { throw new GoogleApiError(500, {}); } };
    await expect(processReviewMirror(db, { locationId: loc.row.id, step: "posts" }, { client: other })).rejects.toThrow(/500/);
    warn.mockRestore();
  });
});

describe("googleConnections.list", () => {
  it("returns accessLost per connection", async () => {
    await pendingSync();
    const list = async () =>
      ((await kit.run(org.owner, "googleConnections.list")) as { connections: { id: string; accessLost: boolean }[] }).connections.find((c) => c.id === connectionId)!.accessLost;
    expect(await list()).toBe(false);
    await db.update(googleConnections).set({ accessLostAt: new Date() }).where(eq(googleConnections.id, connectionId));
    expect(await list()).toBe(true);
  });
});
