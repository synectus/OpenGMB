import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { customerMediaScans, customerMediaSeen, locations, performanceDaily, performanceSnapshots, profileSnapshots, reviewSyncs } from "@opengmb/db";
import { GoogleApiError, GoogleTokenRefreshError } from "./google/errors";
import { processCustomerMediaScan } from "./media/customer";
import { processPerformanceSnapshot } from "./performance/snapshot";
import { processProfileSnapshot } from "./profile/watch";
import { db, makeOrg, sql } from "./performance-fixture";

// OPS3 for the other scheduled per-location Google reads: a location Google cannot find, or access the customer removed,
// ends the job quietly (no throw, so no retry, no failed job and no admin alert) and stores nothing. Everything else still throws.
const gone = () => new GoogleApiError(404, { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } });
const lost = () => new GoogleTokenRefreshError(400, { error: "invalid_grant" });
const boom = () => new GoogleApiError(500, { error: { code: 500, status: "INTERNAL" } });
const forbidden = () => new GoogleApiError(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } });

const failing = (make: () => Error) => new Proxy({}, { get: () => async () => { throw make(); } }) as never;

let warn: ReturnType<typeof vi.spyOn>;
afterEach(() => warn?.mockRestore());
afterAll(async () => { await sql.end(); });

async function loc() {
  const org = await makeOrg();
  const l = org.locA1;
  await db.update(locations).set({ googleAccountName: "accounts/1" }).where(eq(locations.id, l.id));
  return l;
}
// The review sync is what records "Google cannot find this location"; the quiet skip applies only after it did.
const settle = (l: { id: string; orgId: string }, status: "done" | "failed", error: string | null) =>
  db.insert(reviewSyncs).values({ orgId: l.orgId, locationId: l.id, status, error, createdAt: new Date(), finishedAt: new Date() });
const recordedNotFound = (l: { id: string; orgId: string }) => settle(l, "failed", "google_location_not_found");
const warned = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));

describe("performance.snapshot", () => {
  const run = (id: string, make: () => Error) => processPerformanceSnapshot(db, { locationId: id }, { client: failing(make) });
  it("a 404 and lost access end quietly with a skipped result and store nothing", async () => {
    const l = await loc();
    await recordedNotFound(l);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(l.id, gone)).toEqual({ status: "skipped", reason: "google_location_not_found" });
    expect(await run(l.id, lost)).toEqual({ status: "skipped", reason: "google_access_lost" });
    expect(warned()).toHaveLength(2);
    expect(warned()[0]).toContain("performance.snapshot");
    expect(warned()[0]).toContain(l.id);
    expect(warned()[0]).toContain("google_location_not_found");
    expect(await db.select().from(performanceSnapshots).where(eq(performanceSnapshots.locationId, l.id))).toHaveLength(0);
    expect(await db.select().from(performanceDaily).where(eq(performanceDaily.locationId, l.id))).toHaveLength(0);
  });
  it("a 500 still throws", async () => {
    const l = await loc();
    await expect(run(l.id, boom)).rejects.toThrow(/500/);
  });
  it("a 404 while the review sync is healthy (or has never run) still throws, so a platform-wide break stays visible", async () => {
    const l = await loc();
    await expect(run(l.id, gone)).rejects.toThrow(/404/);
    await settle(l, "done", null);
    await expect(run(l.id, gone)).rejects.toThrow(/404/);
  });
});

describe("profile.snapshot", () => {
  const run = (id: string, make: () => Error) => processProfileSnapshot(db, { locationId: id }, { client: failing(make) });
  it("a 404 and lost access end quietly as skipped and store no snapshot, so no baseline and no change", async () => {
    const l = await loc();
    await recordedNotFound(l);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(l.id, gone)).toBe("skipped");
    expect(await run(l.id, lost)).toBe("skipped");
    expect(warned()).toHaveLength(2);
    expect(warned()[1]).toContain("profile.snapshot");
    expect(warned()[1]).toContain("google_access_lost");
    expect(await db.select().from(profileSnapshots).where(eq(profileSnapshots.locationId, l.id))).toHaveLength(0);
  });
  it("a 404 while the review sync is healthy still throws", async () => {
    const l = await loc();
    await settle(l, "done", null);
    await expect(run(l.id, gone)).rejects.toThrow(/404/);
  });
  it("a 500 and a 403 still throw", async () => {
    const l = await loc();
    await expect(run(l.id, boom)).rejects.toThrow(/500/);
    await expect(run(l.id, forbidden)).rejects.toThrow();
  });
});

describe("media.customer_scan", () => {
  const run = (id: string, make: () => Error) => processCustomerMediaScan(db, { locationId: id }, { client: failing(make) });
  it("a 404 and lost access end quietly as skipped and record no scan", async () => {
    const l = await loc();
    await recordedNotFound(l);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(l.id, gone)).toEqual({ status: "skipped", newPhotos: 0 });
    expect(await run(l.id, lost)).toEqual({ status: "skipped", newPhotos: 0 });
    expect(warned()).toHaveLength(2);
    expect(warned()[0]).toContain("media.customer_scan");
    expect(await db.select().from(customerMediaScans).where(eq(customerMediaScans.locationId, l.id))).toHaveLength(0);
    expect(await db.select().from(customerMediaSeen).where(eq(customerMediaSeen.locationId, l.id))).toHaveLength(0);
  });
  it("a 500 still throws", async () => {
    const l = await loc();
    await expect(run(l.id, boom)).rejects.toThrow(/500/);
  });
  it("a 404 while the review sync is healthy still throws", async () => {
    const l = await loc();
    await settle(l, "done", null);
    await expect(run(l.id, gone)).rejects.toThrow(/404/);
  });
});
