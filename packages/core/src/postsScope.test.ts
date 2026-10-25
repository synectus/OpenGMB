import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, googlePosts } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { MockGoogleClient } from "./google/mock-client";
import { googleOnlyPosts, lastPostDates, postCount } from "./posts/scope";
import { makeKit, seedMixedPosts, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());

let org: Org;
let loc: Loc;
let seed: Awaited<ReturnType<typeof seedMixedPosts>>;

beforeAll(async () => {
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  seed = await seedMixedPosts(db, { orgId: org.orgId, ownerId: org.ownerId }, loc);
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("the posts of a location (F6)", () => {
  it("lists the Google-only posts once: not the SynGMB one that is also on Google, not a PROCESSING one", async () => {
    const g = await googleOnlyPosts(db, { orgId: org.orgId, locationIds: [loc.row.id] });
    expect(g.map((x) => x.googlePostName)).toEqual([...seed.names.g].reverse());
    expect(g).toHaveLength(seed.googleOnly);
  });

  it("counts every post in the range once each", async () => {
    const n = await postCount(db, { locationIds: [loc.row.id], ...seed.range });
    expect(n).toBe(seed.total); // 3 Google-only + 2 SynGMB; the draft and the PROCESSING post are not posts
    expect(n).toBe(seed.googleOnly + 2);
  });

  it("last post is the true latest date, whichever side it is on", async () => {
    const last = (await lastPostDates(db, [loc.row.id])).get(loc.row.id)!;
    expect(last.at.toISOString()).toBe(seed.latest);
    expect(last.source).toBe("google");
    await db.delete(googlePosts).where(eq(googlePosts.googlePostName, seed.names.g[2]!));
    const next = (await lastPostDates(db, [loc.row.id])).get(loc.row.id)!;
    expect(next.at.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(next.source).toBe("syngmb");
  });

  it("a location with no posts has no last post and a zero count", async () => {
    const empty = await org.mkLoc(org.a);
    expect((await lastPostDates(db, [empty.row.id])).size).toBe(0);
    expect(await postCount(db, { locationIds: [empty.row.id], ...seed.range })).toBe(0);
    expect(await googleOnlyPosts(db, { orgId: org.orgId, locationIds: [empty.row.id] })).toEqual([]);
  });
});
