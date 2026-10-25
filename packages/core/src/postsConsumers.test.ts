import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { makeKit, seedMixedPosts, type Loc, type Org } from "./testkit";

// F6: every place that shows posts reads the same definition (posts/scope.ts), so on one seed
// (3 Google-only + 2 SynGMB, one of which is also on Google, + a draft + a PROCESSING one) they agree.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

let org: Org;
let loc: Loc;
let seed: Awaited<ReturnType<typeof seedMixedPosts>>;
const from = "2026-10-01";
const to = "2026-10-31";

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  seed = await seedMixedPosts(db, { orgId: org.orgId, ownerId: org.ownerId }, loc);
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type ListOut = { posts: { id: string; status: string }[]; googleOnly: { googlePostName: string; searchUrl: string | null }[] };

describe("posts consumers agree on the seed", () => {
  it("All posts: SynGMB posts and the Google-only ones, the shared post only as SynGMB's", async () => {
    const r = await run<ListOut>(org.owner, "posts.list", { workspaceId: org.a });
    expect(r.posts.map((p) => p.id).sort()).toEqual([seed.mine1.id, seed.mine2.id, seed.draft.id].sort());
    expect(r.googleOnly.map((g) => g.googlePostName).sort()).toEqual([...seed.names.g].sort());
    expect(r.googleOnly.some((g) => g.googlePostName === seed.names.mine2)).toBe(false);
    expect(r.googleOnly.every((g) => g.searchUrl)).toBe(true);
    const published = r.posts.filter((p) => p.status === "published").length;
    expect(published + r.googleOnly.length).toBe(seed.total);
  });

  it("All posts: a SynGMB-only status filter lists no Google-only posts; location and text filters apply", async () => {
    expect((await run<ListOut>(org.owner, "posts.list", { status: "draft" })).googleOnly).toEqual([]);
    expect((await run<ListOut>(org.owner, "posts.list", { locationId: loc.row.id, q: "google G2" })).googleOnly).toHaveLength(1);
  });

  it("Calendar: one entry per post on its date", async () => {
    const r = await run<{ entries: { kind: string; postId: string; at: string; searchUrl?: string | null }[] }>(
      org.owner,
      "posts.calendar",
      { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", workspaceId: org.a },
    );
    expect(r.entries.filter((e) => e.kind === "google")).toHaveLength(seed.googleOnly);
    expect(r.entries.filter((e) => e.kind === "published").map((e) => e.postId).sort()).toEqual(
      [seed.mine1.id, seed.mine2.id].sort(),
    );
    expect(r.entries).toHaveLength(seed.total);
    expect(r.entries.find((e) => e.kind === "google")?.searchUrl).toMatch(/^https:/);
  });

  it("Home card: last post is the true latest date", async () => {
    const q = await run<{ locations: { lastPostAt: string | null }[] }>(org.owner, "attention.queue", { workspaceId: org.a });
    expect(q.locations).toHaveLength(1);
    expect(q.locations[0]!.lastPostAt).toBe(seed.latest);
  });

  it("Performance: posts published counts each once", async () => {
    const r = await run<{ postsPublished: number }>(org.owner, "performance.activity", { workspaceId: org.a, from, to });
    expect(r.postsPublished).toBe(seed.total);
  });

  it("Overview: last post is the same date, labelled as made on Google", async () => {
    const r = await run<{ lastPost: { publishedAt: string; summary: string; source: string; createdSurface: string | null } | null }>(
      org.owner,
      "locations.overview",
      { locationId: loc.row.id },
    );
    expect(r.lastPost).toEqual({ publishedAt: seed.latest, summary: "google G3", source: "google", createdSurface: null });
  });
});
