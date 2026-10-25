import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, locations, memberships, organizations, reviews, users, workspaces } from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;

type Item = { id: string; rating: number | null; comment: string | null; reviewer: { displayName: string | null } };
type Out = { items: Item[]; nextCursor: string | null };

let seq = 0;
async function setup() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const [a, b] = await db.insert(workspaces).values([{ orgId, name: "A" }, { orgId, name: "B" }]).returning();
  const id = `u-${uniq()}`;
  await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  await db.insert(memberships).values({ orgId, userId: id, role: "owner" });
  const actor = await loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, `${id}@example.test`);
  const mkLoc = async (workspaceId: string, name: string) => {
    const n = uniqDigits();
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name,
        googleAccountName: `accounts/9${n.slice(-8)}`,
        googleLocationId: `locations/9${n.slice(-10)}`,
        connectionId,
        status: "active",
      })
      .returning();
    return l!;
  };
  return { orgId, a: a!.id, b: b!.id, actor, mkLoc };
}
type Loc = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["mkLoc"]>>;

async function mk(
  loc: Loc,
  o: { rating?: number | null; comment?: string | null; reviewer?: string | null; anonymous?: boolean; at: string; reply?: string },
) {
  const createTime = new Date(o.at);
  await db.insert(reviews).values({
    orgId: loc.orgId,
    workspaceId: loc.workspaceId,
    locationId: loc.id,
    googleReviewName: `accounts/1/locations/1/reviews/s${uniq()}-${seq++}`,
    reviewerDisplayName: o.reviewer === undefined ? "Rev" : o.reviewer,
    reviewerIsAnonymous: o.anonymous ?? false,
    starRating: o.rating === undefined ? 5 : o.rating,
    comment: o.comment === undefined ? "text" : o.comment,
    createTime,
    updateTime: createTime,
    replyComment: o.reply ?? null,
    replyUpdateTime: o.reply ? createTime : null,
  });
}

afterAll(async () => {
  await sql.end();
});

describe("reviews.list search and sort", () => {
  let actor: Actor;
  let a: string;
  let locA: Loc;
  let locB: Loc;
  const list = (input: Record<string, unknown> = {}) =>
    executeAction(db, actor, "reviews.list", input) as Promise<Out>;
  const names = (o: Out) => o.items.map((i) => i.reviewer.displayName);

  beforeAll(async () => {
    const s = await setup();
    actor = s.actor;
    a = s.a;
    locA = await s.mkLoc(s.a, "Loc A");
    locB = await s.mkLoc(s.b, "Loc B");
    await mk(locA, { reviewer: "Alice", rating: 5, comment: "Great Parking and friendly staff", at: "2026-09-01T00:00:00Z" });
    await mk(locA, { reviewer: "Bob", rating: 1, comment: "Waited too long", at: "2026-09-02T00:00:00Z", reply: "Sorry" });
    await mk(locA, { reviewer: "Carol", rating: 3, comment: "Insurance paperwork took a while", at: "2026-09-03T00:00:00Z" });
    await mk(locB, { reviewer: "Dave", rating: 5, comment: "100% happy, rate_five", at: "2026-09-04T00:00:00Z" });
    await mk(locB, { reviewer: "Erin O'Neil", rating: 3, comment: null, at: "2026-09-05T00:00:00Z" });
    await mk(locB, { reviewer: "Frank", rating: null, comment: "No stars given", at: "2026-09-06T00:00:00Z" });
    await mk(locB, { reviewer: "Secretname", anonymous: true, rating: 2, comment: "Anonymous gripe", at: "2026-09-07T00:00:00Z" });
  });

  it("finds a phrase in the review text, case-insensitively", async () => {
    expect(names(await list({ q: "friendly staff" }))).toEqual(["Alice"]);
    expect(names(await list({ q: "PARKING" }))).toEqual(["Alice"]);
    expect(names(await list({ q: "  paperwork took " }))).toEqual(["Carol"]);
  });

  it("finds a reviewer by name, including an apostrophe, but not an anonymous reviewer's hidden name", async () => {
    expect(names(await list({ q: "erin o'neil" }))).toEqual(["Erin O'Neil"]);
    expect(names(await list({ q: "secretname" }))).toEqual([]);
    expect(names(await list({ q: "gripe" }))).toEqual(["Secretname"]);
  });

  it("treats % and _ as literal characters, so they do not match everything", async () => {
    expect(names(await list({ q: "%" }))).toEqual(["Dave"]);
    expect(names(await list({ q: "_" }))).toEqual(["Dave"]);
    expect(names(await list({ q: "100%" }))).toEqual(["Dave"]);
    expect(names(await list({ q: "rate_five" }))).toEqual(["Dave"]);
    expect(names(await list({ q: "rate%five" }))).toEqual([]);
    expect(names(await list({ q: "\\" }))).toEqual([]);
  });

  it("is not injectable", async () => {
    expect(names(await list({ q: "'; drop table reviews; --" }))).toEqual([]);
    expect((await list()).items.length).toBe(7);
  });

  it("returns nothing for a phrase that is not there and rejects an empty search", async () => {
    expect((await list({ q: "zzzz-nothing" })).items).toEqual([]);
    await expect(list({ q: "" })).rejects.toThrow();
  });

  it("combines with the other filters and the workspace", async () => {
    expect(names(await list({ q: "e", ratings: [5] }))).toEqual(["Dave", "Alice"]);
    expect(names(await list({ q: "long", replied: true }))).toEqual(["Bob"]);
    expect(names(await list({ q: "happy", workspaceId: a }))).toEqual([]);
    expect(names(await list({ q: "happy", locationIds: [locB.id] }))).toEqual(["Dave"]);
  });

  it("sorts by date, newest first by default and oldest first on request", async () => {
    const newest = names(await list());
    expect(newest).toEqual(["Secretname", "Frank", "Erin O'Neil", "Dave", "Carol", "Bob", "Alice"]);
    expect(names(await list({ sort: "newest" }))).toEqual(newest);
    expect(names(await list({ sort: "oldest" }))).toEqual([...newest].reverse());
  });

  it("sorts by rating, unrated last in both directions, ties newest first", async () => {
    expect(names(await list({ sort: "rating_high" }))).toEqual([
      "Dave", "Alice", "Erin O'Neil", "Carol", "Secretname", "Bob", "Frank",
    ]);
    expect(names(await list({ sort: "rating_low" }))).toEqual([
      "Bob", "Secretname", "Erin O'Neil", "Carol", "Dave", "Alice", "Frank",
    ]);
  });

  it("pages through every sort without skipping or repeating a review", async () => {
    for (const sort of ["newest", "oldest", "rating_high", "rating_low"] as const) {
      const whole = names(await list({ sort }));
      const paged: (string | null)[] = [];
      let cursor: string | undefined;
      do {
        const p = await list({ sort, limit: 2, ...(cursor ? { cursor } : {}) });
        paged.push(...names(p));
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      expect(paged, sort).toEqual(whole);
    }
  });

  it("sorts and pages a search result", async () => {
    const p1 = await list({ q: "e", sort: "rating_low", limit: 2 });
    const p2 = await list({ q: "e", sort: "rating_low", limit: 2, cursor: p1.nextCursor! });
    const all = await list({ q: "e", sort: "rating_low" });
    expect([...names(p1), ...names(p2)]).toEqual(names(all).slice(0, 4));
  });
});
