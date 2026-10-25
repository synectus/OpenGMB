import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDb,
  locations,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(async () => {
  await sql.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** Letters only, so a token never looks like a phone number to P.phone. */
const tok = () => Math.random().toString(36).slice(2, 10).replace(/\d/g, "q");
const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;

type Post = {
  id: string;
  status: string;
  topicType: string;
  createdByName: string | null;
  approvedByName: string | null;
  rejectedByName: string | null;
  cancelledByName: string | null;
};

async function setup() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mk = async (role: "owner" | "manager", name: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name, email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role });
    return { id, email: `${id}@example.test` };
  };
  const boss = await mk("owner", "Boss Person");
  const maker = await mk("manager", "Maker Person");
  const { connectionId } = await seedMockGoogleConnection(db, boss.email);
  const n = `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
  const [loc] = await db
    .insert(locations)
    .values({
      orgId,
      workspaceId: ws!.id,
      name: "Clinic",
      googleAccountName: `accounts/8${n.slice(-8)}`,
      googleLocationId: `locations/8${n.slice(-10)}`,
      connectionId,
      phone: "555-0100",
    })
    .returning();
  const actor = (u: { id: string }) =>
    loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
  return { ws: ws!.id, loc: loc!.id, boss: await actor(boss), maker: await actor(maker) };
}

describe("posts.list views: sort, type, text; names on posts", () => {
  it("oldest_submitted puts the earliest submission first; names follow the people", async () => {
    const s = await setup();
    const word = tok();
    const draft = async (input: Record<string, unknown>) =>
      (
        await run<{ post: Post }>(s.maker, "posts.createDraft", {
          workspaceId: s.ws,
          locationIds: [s.loc],
          ...input,
        })
      ).post;
    const event = await draft({
      topicType: "EVENT",
      summary: `Open day ${tok()}.`,
      event: { title: "Open day", startDate: "2026-11-14", endDate: "2026-11-14" },
    });
    const standard = await draft({ topicType: "STANDARD", summary: `Alpha ${word} tip.` });
    expect(standard.createdByName).toBe("Maker Person");
    // Submit the EVENT first, so it is the older submission although it was created first too;
    // then submit STANDARD. newest-created order would put STANDARD first.
    for (const p of [event, standard]) {
      await run(s.maker, "posts.submit", { id: p.id, acknowledgeWarnings: true });
    }
    const oldest = await run<{ posts: Post[] }>(s.boss, "posts.list", {
      workspaceId: s.ws,
      status: "pending_approval",
      sort: "oldest_submitted",
    });
    expect(oldest.posts.map((p) => p.id)).toEqual([event.id, standard.id]);
    const newest = await run<{ posts: Post[] }>(s.boss, "posts.list", {
      workspaceId: s.ws,
      status: "pending_approval",
    });
    expect(newest.posts.map((p) => p.id)).toEqual([standard.id, event.id]);

    const events = await run<{ posts: Post[] }>(s.boss, "posts.list", {
      workspaceId: s.ws,
      topicType: "EVENT",
    });
    expect(events.posts.map((p) => p.id)).toEqual([event.id]);

    const found = await run<{ posts: Post[] }>(s.boss, "posts.list", {
      workspaceId: s.ws,
      q: `ALPHA ${word.toUpperCase()}`,
    });
    expect(found.posts.map((p) => p.id)).toEqual([standard.id]);
    const wildcard = await run<{ posts: Post[] }>(s.boss, "posts.list", {
      workspaceId: s.ws,
      q: "%",
    });
    expect(wildcard.posts).toEqual([]);

    const approved = await run<{ post: Post }>(s.boss, "posts.approve", { id: event.id });
    expect(approved.post.approvedByName).toBe("Boss Person");
    const rejected = await run<{ post: Post }>(s.boss, "posts.reject", {
      id: standard.id,
      reason: "Wait for the hours.",
    });
    expect(rejected.post.rejectedByName).toBe("Boss Person");
    const cancelled = await run<{ post: Post }>(s.boss, "posts.cancel", { id: standard.id });
    expect(cancelled.post.cancelledByName).toBe("Boss Person");
    const got = await run<{ post: Post }>(s.boss, "posts.get", { id: standard.id });
    expect(got.post.createdByName).toBe("Maker Person");
    expect(got.post.approvedByName).toBeNull();
  });
});
