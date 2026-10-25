import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, googlePosts } from "@opengmb/db";
import type { GoogleLocalPost } from "./google/client";
import { MockGoogleClient } from "./google/mock-client";
import { syncGooglePosts } from "./posts/google-sync";
import { makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);

let org: Org;
let loc: Loc;
let remote: GoogleLocalPost[] = [];
const fake = { listLocalPosts: async () => ({ localPosts: structuredClone(remote) }) };
const post = (n: number, extra: Partial<GoogleLocalPost> = {}): GoogleLocalPost => ({
  name: `${loc.parent}/localPosts/P${n}`,
  topicType: "STANDARD",
  summary: `post ${n}`,
  state: "LIVE",
  createTime: `2026-10-0${n}T10:00:00Z`,
  searchUrl: `https://search.example.test/${n}`,
  ...extra,
});
const rows = () => db.select().from(googlePosts).where(eq(googlePosts.locationId, loc.row.id));

beforeAll(async () => {
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("syncGooglePosts", () => {
  it("stores every post, keeps the state, and is idempotent", async () => {
    remote = [post(1), post(2), post(3, { state: "REJECTED" })];
    expect(await syncGooglePosts(db, loc.row, fake)).toEqual({ fetched: 3, removed: 0, truncated: false });
    await syncGooglePosts(db, loc.row, fake);
    const r = await rows();
    expect(r).toHaveLength(3);
    expect(r.find((x) => x.summary === "post 3")?.state).toBe("REJECTED");
    expect(r.find((x) => x.summary === "post 1")?.googleCreatedAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("updates changed posts and deletes the ones Google no longer lists", async () => {
    remote = [post(1, { summary: "post 1 edited" }), post(2)];
    expect(await syncGooglePosts(db, loc.row, fake)).toMatchObject({ fetched: 2, removed: 1 });
    const r = await rows();
    expect(r.map((x) => x.summary).sort()).toEqual(["post 1 edited", "post 2"]);
    remote = [];
    await syncGooglePosts(db, loc.row, fake);
    expect(await rows()).toHaveLength(0);
  });
});

describe("posts.syncGoogle", () => {
  it("stores the location's Google posts for the caller, and refuses a stranger", async () => {
    const { setSharedMockGoogleClient } = await import("./google/factory");
    process.env.GOOGLE_BUSINESS_API_MODE = "mock";
    const m = new MockGoogleClient();
    setSharedMockGoogleClient(m);
    const l = await org.mkLoc(org.a);
    await m.createLocalPost(l.parent, { topicType: "STANDARD", summary: "made on Google, synced on demand" });
    const out = await kit.run<{ fetched: number; removed: number; truncated: boolean }>(org.owner, "posts.syncGoogle", { locationId: l.row.id });
    expect(out).toEqual({ fetched: 1, removed: 0, truncated: false });
    const rows = await db.select().from(googlePosts).where(eq(googlePosts.locationId, l.row.id));
    expect(rows.map((r) => r.summary)).toEqual(["made on Google, synced on demand"]);
    const other = await kit.makeOrg();
    await expect(kit.run(other.owner, "posts.syncGoogle", { locationId: l.row.id })).rejects.toThrow();
  });
});
