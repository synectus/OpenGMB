import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { locations, reviewSyncs } from "@opengmb/db";
import { locationsNotFoundAmong } from "./not-found";
import { db, makeOrg, sql } from "../performance-fixture";

afterAll(async () => { await sql.end(); });
const t = (n: number) => new Date(Date.UTC(2031, 0, 1, 0, n));
const sync = (orgId: string, locationId: string, status: "pending" | "done" | "failed", error: string | null, n: number) =>
  db.insert(reviewSyncs).values({ orgId, locationId, status, error, createdAt: t(n), finishedAt: status === "pending" ? null : t(n) });

describe("locationsNotFoundAmong", () => {
  it("lists active locations whose newest settled sync failed with not found, only among the ids given, and clears on a later success", async () => {
    const o = await makeOrg();
    const [a, b, c, off] = [o.locA1, o.locA2, o.locB, o.locAOff];
    await sync(o.orgId, a.id, "failed", "google_location_not_found", 1);
    await sync(o.orgId, a.id, "pending", null, 2); // a queued retry does not hide it
    await sync(o.orgId, b.id, "failed", "google_location_not_found", 1);
    await sync(o.orgId, b.id, "done", null, 2); // recovered
    await sync(o.orgId, c.id, "failed", "google_location_not_found", 1); // another workspace
    await sync(o.orgId, off.id, "failed", "google_location_not_found", 1); // inactive
    const names = (await locationsNotFoundAmong(db, [a.id, b.id, off.id])).map((r) => r.name);
    expect(names).toEqual(["Acme Dental"]);
    expect((await locationsNotFoundAmong(db, [a.id, b.id, c.id])).map((r) => r.name)).toEqual(["Acme Dental", "Other Co"]);
    expect(await locationsNotFoundAmong(db, [])).toEqual([]);
    await sync(o.orgId, a.id, "done", null, 3);
    expect(await locationsNotFoundAmong(db, [a.id])).toEqual([]);
    await db.update(locations).set({ title: "" }).where(eq(locations.id, c.id));
    expect((await locationsNotFoundAmong(db, [c.id])).map((r) => r.name)).toEqual([c.name]);
  });
  it("another error code does not count", async () => {
    const o = await makeOrg();
    await sync(o.orgId, o.locA1.id, "failed", "location_inactive", 1);
    expect(await locationsNotFoundAmong(db, [o.locA1.id])).toEqual([]);
  });
});
