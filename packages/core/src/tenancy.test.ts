import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, memberships, organizations, users, workspaces } from "@opengmb/db";
import type { Db } from "@opengmb/db";
import {
  AccessError,
  OrgSelectionRequiredError,
  authorize,
  getActorContext,
  loadActor,
  workspaceScope,
  type Actor,
} from "./actor";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from "./permissions";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(d: Db) {
  const id = `u-${uniq()}`;
  await d.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  return id;
}
async function makeOrg(d: Db) {
  const [o] = await d
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  return o!.id;
}
async function makeWorkspace(d: Db, orgId: string) {
  const [w] = await d
    .insert(workspaces)
    .values({ orgId, name: `ws-${uniq()}` })
    .returning();
  return w!.id;
}
const actorOf = (role: Role, workspaceIds: string[] | "all" = "all"): Actor => ({
  userId: "u",
  orgId: "o",
  role,
  workspaceIds,
  surface: "ui",
  actorType: "user",
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AccessError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe("role x permission matrix", () => {
  // Independent literal copy of the expected matrix, so editing ROLE_PERMISSIONS alone fails here.
  const expected: Record<Role, Permission[]> = {
    owner: [
      "workspace:read",
      "workspace:create",
      "workspace:manage",
      "workspace:erase",
      "location:read",
      "location:manage",
      "audit:read",
      "api_token:manage_own",
      "api_token:manage_org",
      "google:read",
      "google:manage",
      "notification:own",
      "review:read",
      "geogrid:read",
      "report:read",
      "review:draft",
      "review:approve",
      "review:publish",
      "geogrid:manage",
      "geogrid:cost",
      "report:manage",
      "profile:edit",
      "review:configure",
      "member:invite",
      "branding:manage",
      "member:reset_two_factor",
      "webhook:manage",
      "billing:read",
      "billing:manage",
    ],
    admin: [
      "workspace:read",
      "workspace:create",
      "workspace:manage",
      "location:read",
      "location:manage",
      "audit:read",
      "api_token:manage_own",
      "api_token:manage_org",
      "google:read",
      "google:manage",
      "notification:own",
      "review:read",
      "geogrid:read",
      "report:read",
      "review:draft",
      "review:approve",
      "review:publish",
      "geogrid:manage",
      "geogrid:cost",
      "report:manage",
      "profile:edit",
      "review:configure",
      "member:invite",
      "branding:manage",
      "webhook:manage",
      "billing:read",
    ],
    manager: [
      "workspace:read",
      "workspace:create",
      "location:read",
      "location:manage",
      "api_token:manage_own",
      "google:read",
      "notification:own",
      "review:read",
      "geogrid:read",
      "report:read",
      "review:draft",
      "review:approve",
      "review:publish",
      "geogrid:manage",
      "geogrid:cost",
      "report:manage",
      "profile:edit",
      "member:invite",
    ],
    client_approver: [
      "workspace:read",
      "location:read",
      "api_token:manage_own",
      "notification:own",
      "review:read",
      "geogrid:read",
      "report:read",
      "review:approve",
    ],
    client_viewer: [
      "workspace:read",
      "location:read",
      "api_token:manage_own",
      "notification:own",
      "review:read",
      "geogrid:read",
      "report:read",
    ],
  };
  const cases = (Object.keys(expected) as Role[]).flatMap((role) =>
    PERMISSIONS.map((p) => [role, p, expected[role].includes(p)] as const),
  );

  it.each(cases)("%s / %s -> allow=%s", (role, permission, allow) => {
    expect(code(() => authorize(actorOf(role), permission))).toBe(allow ? undefined : "FORBIDDEN");
  });

  it("covers every role and permission (denominator)", () => {
    expect(cases.length).toBe(5 * 29);
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.keys(expected).sort());
    console.log(`permission matrix: ${cases.length} role x permission cases`);
  });
});

describe("workspace scoping", () => {
  it("client_viewer of A may read A, not B; scope is [A]", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const actor = actorOf("client_viewer", [a]);
    expect(code(() => authorize(actor, "workspace:read", { workspaceId: a }))).toBeUndefined();
    expect(code(() => authorize(actor, "workspace:read", { workspaceId: b }))).toBe("FORBIDDEN");
    expect(workspaceScope(actor)).toEqual([a]);
  });
  it("org-wide roles have scope 'all'", () => {
    expect(workspaceScope(actorOf("manager"))).toBe("all");
    expect(
      code(() =>
        authorize(actorOf("manager"), "workspace:read", { workspaceId: crypto.randomUUID() }),
      ),
    ).toBeUndefined();
  });
});

describe("loadActor", () => {
  it("no memberships -> FORBIDDEN", async () => {
    const userId = await makeUser(db);
    await expect(loadActor(db, { userId, surface: "ui", actorType: "user" })).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
  });

  it("two orgs and no orgId -> OrgSelectionRequiredError; with orgId it resolves", async () => {
    const userId = await makeUser(db);
    const o1 = await makeOrg(db);
    const o2 = await makeOrg(db);
    await db.insert(memberships).values([
      { orgId: o1, userId, role: "owner" },
      { orgId: o2, userId, role: "manager" },
    ]);
    const err = await loadActor(db, { userId, surface: "ui", actorType: "user" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrgSelectionRequiredError);
    expect(err.code).toBe("INVALID_INPUT");
    const actor = await loadActor(db, { userId, orgId: o2, surface: "mcp", actorType: "user" });
    expect(actor).toMatchObject({
      orgId: o2,
      role: "manager",
      workspaceIds: "all",
      surface: "mcp",
    });
  });

  it("single org is inferred; client memberships list their workspaces; org-wide wins", async () => {
    const orgId = await makeOrg(db);
    const wa = await makeWorkspace(db, orgId);
    const wb = await makeWorkspace(db, orgId);
    const client = await makeUser(db);
    await db.insert(memberships).values([
      { orgId, userId: client, workspaceId: wa, role: "client_viewer" },
      { orgId, userId: client, workspaceId: wb, role: "client_viewer" },
    ]);
    const c = await loadActor(db, { userId: client, surface: "ui", actorType: "user" });
    expect(c.role).toBe("client_viewer");
    expect([...(c.workspaceIds as string[])].sort()).toEqual([wa, wb].sort());

    const both = await makeUser(db);
    await db.insert(memberships).values([
      { orgId, userId: both, workspaceId: wa, role: "client_viewer" },
      { orgId, userId: both, role: "admin" },
    ]);
    const b = await loadActor(db, { userId: both, surface: "ui", actorType: "user" });
    expect(b).toMatchObject({ role: "admin", workspaceIds: "all" });
  });

  it("carries apiTokenId and getActorContext returns org name and role", async () => {
    const userId = await makeUser(db);
    const orgId = await makeOrg(db);
    await db.insert(memberships).values({ orgId, userId, role: "owner" });
    const actor = await loadActor(db, {
      userId,
      surface: "mcp",
      actorType: "api_token",
      apiTokenId: "tok-1",
    });
    expect(actor.apiTokenId).toBe("tok-1");
    const ctx = await getActorContext(db, actor);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(ctx).toEqual({
      organization: { id: orgId, name: o!.name },
      role: "owner",
      home: "app",
    });
  });

  it("client roles get the portal home; a mix of client roles collapses to client_viewer", async () => {
    const orgId = await makeOrg(db);
    const wa = await makeWorkspace(db, orgId);
    const wb = await makeWorkspace(db, orgId);
    const approver = await makeUser(db);
    await db
      .insert(memberships)
      .values({ orgId, userId: approver, workspaceId: wa, role: "client_approver" });
    const a = await loadActor(db, { userId: approver, surface: "ui", actorType: "user" });
    expect((await getActorContext(db, a)).home).toBe("portal");

    const mixed = await makeUser(db);
    await db.insert(memberships).values([
      { orgId, userId: mixed, workspaceId: wa, role: "client_approver" },
      { orgId, userId: mixed, workspaceId: wb, role: "client_viewer" },
    ]);
    const m = await loadActor(db, { userId: mixed, surface: "ui", actorType: "user" });
    expect(m.role).toBe("client_viewer");
  });
});
