import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  googlePosts,
  locations,
  memberships,
  organizations,
  postTargets,
  posts,
  users,
  workspaces,
  type Db,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import type { MockGoogleClient } from "./google/mock-client";

/** Shared fixtures for the profile watch / media / suspension / place action suites. Tests only. */
let locSeq = 0;
export const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

export function makeKit(db: Db, mock: MockGoogleClient) {
  const created: string[] = [];
  const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
    executeAction(db, actor, name, input) as Promise<T>;

  async function makeOrg() {
    const [org] = await db
      .insert(organizations)
      .values({ name: `org-${uniq()}` })
      .returning();
    const orgId = org!.id;
    const [a, b] = await db
      .insert(workspaces)
      .values([
        { orgId, name: "A" },
        { orgId, name: "B" },
      ])
      .returning();
    const mkUser = async (
      role: "owner" | "manager" | "client_approver" | "client_viewer",
      workspaceId?: string,
    ) => {
      const id = `u-${uniq()}`;
      await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
      await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
      return { id, email: `${id}@example.test` };
    };
    const owner = await mkUser("owner");
    const actor = (u: { id: string }) =>
      loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
    const { connectionId } = await seedMockGoogleConnection(db, owner.email);
    /** A location row plus a matching location in the mock Google. */
    const mkLoc = async (
      workspaceId: string,
      extra: Partial<typeof locations.$inferInsert> = {},
    ) => {
      const n = `${uniq().replace(/\D/g, "").slice(-9)}${String(++locSeq).padStart(3, "0")}`;
      const name = `locations/7${n}`;
      mock.addLocation({ name, title: `Clinic ${n}` });
      const [l] = await db
        .insert(locations)
        .values({
          orgId,
          workspaceId,
          name: `Clinic ${n}`,
          googleAccountName: "accounts/100000000000000000001",
          googleLocationId: name,
          connectionId,
          phone: "+1 555 010 0199",
          ...extra,
        })
        .returning();
      created.push(l!.id);
      return { row: l!, google: name, parent: `accounts/100000000000000000001/${name}` };
    };
    const ownerU = await actor(owner);
    return {
      orgId,
      a: a!.id,
      b: b!.id,
      owner: ownerU,
      manager: await actor(await mkUser("manager")),
      approverA: await actor(await mkUser("client_approver", a!.id)),
      approverB: await actor(await mkUser("client_approver", b!.id)),
      viewerA: await actor(await mkUser("client_viewer", a!.id)),
      ownerId: owner.id,
      mkLoc,
    };
  }

  /** Other suites fan out over every active location in the shared test DB: leave none of ours active. */
  const deactivateAll = () =>
    db.update(locations).set({ status: "inactive" }).where(inArray(locations.id, created));

  const auditRows = (orgId: string, action: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));

  return { makeOrg, run, created, deactivateAll, auditRows };
}
export type Kit = ReturnType<typeof makeKit>;
export type Org = Awaited<ReturnType<Kit["makeOrg"]>>;
export type Loc = Awaited<ReturnType<Org["mkLoc"]>>;

/**
 * F6 seed: one location with 3 Google-only posts, 2 SynGMB-published posts (one of them also on
 * Google, so it has a mirror row too), 1 PROCESSING Google post and 1 SynGMB draft.
 * Distinct published posts: 5 (the draft and the PROCESSING one are not). The latest post is Google-only (2026-10-12).
 */
export async function seedMixedPosts(
  db: Db,
  org: { orgId: string; ownerId: string },
  loc: { row: { id: string; workspaceId: string }; parent: string },
) {
  const name = (n: string) => `${loc.parent}/localPosts/${n}`;
  const mirror = (n: string, at: string, extra: Partial<typeof googlePosts.$inferInsert> = {}) => ({
    orgId: org.orgId,
    locationId: loc.row.id,
    googlePostName: name(n),
    topicType: "STANDARD",
    state: "LIVE",
    summary: `google ${n}`,
    searchUrl: `https://search.example.test/${n}`,
    googleCreatedAt: new Date(at),
    ...extra,
  });
  await db.insert(googlePosts).values([
    mirror("G1", "2026-10-01T09:00:00Z"),
    mirror("G2", "2026-10-05T09:00:00Z"),
    mirror("G3", "2026-10-12T09:00:00Z"),
    mirror("MINE2", "2026-10-10T09:05:00Z"), // SynGMB post 2, as Google lists it
    mirror("PROC", "2026-10-20T09:00:00Z", { state: "PROCESSING" }),
  ]);
  const mk = async (summary: string, status: "published" | "draft", at?: string, googleName?: string) => {
    const [p] = await db
      .insert(posts)
      .values({
        orgId: org.orgId,
        workspaceId: loc.row.workspaceId,
        createdBy: org.ownerId,
        createdSurface: "ui",
        topicType: "STANDARD",
        summary,
        status,
      })
      .returning();
    if (at)
      await db.insert(postTargets).values({
        postId: p!.id,
        orgId: org.orgId,
        locationId: loc.row.id,
        status: "published",
        publishedAt: new Date(at),
        googlePostName: googleName ?? name(`SG-${summary}`),
      });
    return p!;
  };
  const mine1 = await mk("mine one", "published", "2026-10-03T09:00:00Z");
  const mine2 = await mk("mine two", "published", "2026-10-10T09:00:00Z", name("MINE2"));
  const draft = await mk("a draft", "draft");
  return {
    googleOnly: 3,
    total: 5,
    latest: "2026-10-12T09:00:00.000Z",
    range: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") },
    mine1,
    mine2,
    draft,
    names: { g: [name("G1"), name("G2"), name("G3")], mine2: name("MINE2") },
  };
}
