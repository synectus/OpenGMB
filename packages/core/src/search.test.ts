import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  locationGroupMembers,
  locationGroups,
  locations,
  memberships,
  organizations,
  postTargets,
  posts,
  reviewNotes,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;

type Out = {
  locations: { id: string; name: string }[];
  reviews: { id: string; snippet: string | null; reviewer: string | null }[];
  posts: { id: string; snippet: string }[];
};

describe("search.everything", () => {
  const tag = `zq${randomInt(10_000, 99_999)}`;
  let owner: Actor;
  let clientA: Actor;
  let wa: string;
  let wb: string;
  let locA: string;
  let locB: string;
  let locInactive: string;
  let groupA: string;
  const ids: Record<string, string> = {};
  const search = (actor: Actor, input: Record<string, unknown>) =>
    executeAction(db, actor, "search.everything", { q: tag, ...input }) as Promise<Out>;

  beforeAll(async () => {
    const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    const orgId = org!.id;
    const [a, b] = await db.insert(workspaces).values([{ orgId, name: "A" }, { orgId, name: "B" }]).returning();
    wa = a!.id;
    wb = b!.id;
    const mkUser = async (role: "owner" | "client_approver", workspaceId?: string) => {
      const id = `u-${uniq()}`;
      await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
      await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
      return id;
    };
    const ownerId = await mkUser("owner");
    owner = await loadActor(db, { userId: ownerId, surface: "ui", actorType: "user" });
    clientA = await loadActor(db, { userId: await mkUser("client_approver", wa), surface: "ui", actorType: "user" });
    const { connectionId } = await seedMockGoogleConnection(db, `${ownerId}@example.test`);
    const mkLoc = async (workspaceId: string, name: string, status: "active" | "inactive" = "active") => {
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
          status,
        })
        .returning();
      return l!.id;
    };
    locA = await mkLoc(wa, `Clinic ${tag} Alpha`);
    locB = await mkLoc(wb, `Clinic ${tag} Beta`);
    locInactive = await mkLoc(wa, `Old ${tag} site`, "inactive");
    const [g] = await db.insert(locationGroups).values({ orgId, workspaceId: wa, name: `G-${tag}` }).returning();
    groupA = g!.id;
    await db.insert(locationGroupMembers).values({ orgId, groupId: groupA, locationId: locA });
    let seq = 0;
    const mkReview = async (key: string, workspaceId: string, locationId: string, comment: string, anonymous = false) => {
      const t = new Date(Date.UTC(2026, 8, 1 + seq));
      const [r] = await db
        .insert(reviews)
        .values({
          orgId,
          workspaceId,
          locationId,
          googleReviewName: `accounts/1/locations/1/reviews/${tag}-${seq++}`,
          reviewerDisplayName: anonymous ? `Anon ${tag}` : "Rev",
          reviewerIsAnonymous: anonymous,
          starRating: 4,
          comment,
          createTime: t,
          updateTime: t,
        })
        .returning();
      ids[key] = r!.id;
    };
    await mkReview("revA", wa, locA, `The ${tag} root canal was painless`);
    await mkReview("revB", wb, locB, `Loved the ${tag} waiting room`);
    await mkReview("revInactive", wa, locInactive, `${tag} on the closed site`);
    await mkReview("revAnon", wa, locA, "plain text", true);
    await db.insert(reviewNotes).values({
      orgId,
      workspaceId: wa,
      reviewId: ids.revA!,
      authorUserId: ownerId,
      body: `internal ${tag}-secret note`,
    });
    const mkPost = async (key: string, workspaceId: string, locationId: string, summary: string) => {
      const [p] = await db
        .insert(posts)
        .values({ orgId, workspaceId, createdBy: ownerId, createdSurface: "ui", topicType: "STANDARD", summary })
        .returning();
      await db.insert(postTargets).values({ orgId, postId: p!.id, locationId });
      ids[key] = p!.id;
    };
    await mkPost("postA", wa, locA, `Spring offer ${tag} for new patients`);
    await mkPost("postB", wb, locB, `Autumn offer ${tag}`);
  }, 60_000);

  it("finds a location, a review and a post by text, with an owner seeing both clients", async () => {
    const r = await search(owner, {});
    expect(r.locations.map((l) => l.name).sort()).toEqual([`Clinic ${tag} Alpha`, `Clinic ${tag} Beta`, `Old ${tag} site`]);
    expect(r.reviews.map((x) => x.id).sort()).toEqual([ids.revA!, ids.revB!].sort());
    expect(r.posts.map((x) => x.id).sort()).toEqual([ids.postA!, ids.postB!].sort());
  });

  it("matches case-insensitively and literally (% is not a wildcard)", async () => {
    const r = await search(owner, { q: tag.toUpperCase() });
    expect(r.reviews).toHaveLength(2);
    expect((await search(owner, { q: "%%%" })).reviews).toEqual([]);
  });

  it("searches reviews and posts only from three characters", async () => {
    const r = (await executeAction(db, owner, "search.everything", { q: "c" })) as Out;
    expect(r.reviews).toEqual([]);
    expect(r.posts).toEqual([]);
  });

  it("caps each kind at limitPerKind", async () => {
    const r = await search(owner, { limitPerKind: 1 });
    expect([r.locations.length, r.reviews.length, r.posts.length]).toEqual([1, 1, 1]);
  });

  it("narrows to a client, a group and a list of locations", async () => {
    const byWs = await search(owner, { workspaceId: wb });
    expect(byWs.reviews.map((x) => x.id)).toEqual([ids.revB!]);
    expect(byWs.posts.map((x) => x.id)).toEqual([ids.postB!]);
    const byGroup = await search(owner, { groupId: groupA });
    expect(byGroup.reviews.map((x) => x.id)).toEqual([ids.revA!]);
    expect(byGroup.posts.map((x) => x.id)).toEqual([ids.postA!]);
    expect(byGroup.locations.map((l) => l.id)).toEqual([locA]);
    const byLoc = await search(owner, { locationIds: [locB] });
    expect(byLoc.reviews.map((x) => x.id)).toEqual([ids.revB!]);
  });

  it("leaves reviews of inactive locations out, and never searches an anonymous reviewer's name", async () => {
    const r = await search(owner, {});
    expect(r.reviews.map((x) => x.id)).not.toContain(ids.revInactive);
    expect(r.reviews.map((x) => x.id)).not.toContain(ids.revAnon);
  });

  it("never searches or returns internal review notes", async () => {
    const r = await search(owner, { q: `${tag}-secret` });
    expect(r.reviews).toEqual([]);
    expect(JSON.stringify(await search(owner, {}))).not.toContain("secret");
  });

  it("a client role only sees its own client, and cannot aim at another", async () => {
    const r = await search(clientA, {});
    expect(r.reviews.map((x) => x.id)).toEqual([ids.revA!]);
    expect(r.posts.map((x) => x.id)).toEqual([ids.postA!]);
    expect(r.locations.map((l) => l.id).sort()).toEqual([locA, locInactive].sort());
    await expect(search(clientA, { workspaceId: wb })).rejects.toThrow();
    const viaIds = await search(clientA, { locationIds: [locB] });
    expect(viaIds).toEqual({ locations: [], reviews: [], posts: [] });
  });
});
