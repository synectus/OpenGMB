import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  createDb,
  memberships,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import type { Db } from "@opengmb/db";
import type { Actor } from "../actor";
import { executeAction } from "../executor";
import type { Role } from "../permissions";
import { approveConnection, connectableOrgs, endOAuthGrants, oauthClientName } from "./connections";
import { executeToolCall } from "../executor";
import { actorFromTokenRow, createApiTokenFor } from "../apiTokens";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeOrg(d: Db, name = `org-${uniq()}`) {
  const [o] = await d.insert(organizations).values({ name }).returning();
  return o!.id;
}
async function makeUser(d: Db) {
  const id = `u-${uniq()}`;
  await d.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  return id;
}
async function join(d: Db, orgId: string, userId: string, role: Role) {
  if (role === "client_approver" || role === "client_viewer") {
    const [w] = await d
      .insert(workspaces)
      .values({ orgId, name: `ws-${uniq()}` })
      .returning();
    await d.insert(memberships).values({ orgId, userId, role, workspaceId: w!.id });
  } else {
    await d.insert(memberships).values({ orgId, userId, role });
  }
}
async function makeMember(d: Db, orgId: string, role: Role) {
  const userId = await makeUser(d);
  await join(d, orgId, userId, role);
  const actor: Actor = {
    userId,
    orgId,
    role,
    workspaceIds: "all",
    surface: "ui",
    actorType: "user",
  };
  return { userId, actor };
}
async function makeClient(d: Db) {
  const clientId = `client-${uniq()}`;
  await d
    .insert(oauthClients)
    .values({ id: randomUUID(), clientId, name: "Claude", redirectUris: ["https://claude.ai/cb"] });
  return clientId;
}
const app = (clientId: string, over: Record<string, unknown> = {}) => ({
  clientId,
  clientName: "Claude",
  redirectHost: "claude.ai",
  access: "write" as const,
  fullAutonomy: false,
  ...over,
});
const rowsOf = (orgId: string, userId: string) =>
  db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.userId, userId)));

describe("connectableOrgs", () => {
  it("canary: a one-org owner gets that org, not read-only", async () => {
    const orgId = await makeOrg(db, `Solo ${uniq()}`);
    const m = await makeMember(db, orgId, "owner");
    const out = await connectableOrgs(db, m.userId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ orgId, readOnly: false });
  });
  it("lists each org once, by name; a client_viewer org is read-only", async () => {
    const a = await makeOrg(db, `Agency ${uniq()}`);
    const b = await makeOrg(db, `Zed portal ${uniq()}`);
    const userId = await makeUser(db);
    await join(db, a, userId, "manager");
    await join(db, b, userId, "client_viewer");
    // a second workspace-level membership in the same org must not duplicate the org
    await join(db, b, userId, "client_viewer");
    const out = await connectableOrgs(db, userId);
    expect(out.map((o) => [o.orgId, o.readOnly])).toEqual([
      [a, false],
      [b, true],
    ]);
    expect(out[0]!.name.startsWith("Agency")).toBe(true);
  });
  it("a person with no membership has no accounts", async () => {
    expect(await connectableOrgs(db, await makeUser(db))).toEqual([]);
  });
});

describe("oauthClientName", () => {
  it("returns the registered name, and null for an unknown client", async () => {
    expect(await oauthClientName(db, await makeClient(db))).toEqual({ name: "Claude" });
    expect(await oauthClientName(db, "no-such-client")).toBeNull();
  });
});

describe("approveConnection", () => {
  it("inserts one live row with the app name, redirect host and a hash nobody holds, and audits oauth_app.connect", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const res = await approveConnection(db, { userId: m.userId, orgId, ...app(clientId) });
    expect(res.created).toBe(true);
    const [row] = await rowsOf(orgId, m.userId);
    expect(row).toMatchObject({
      id: res.id,
      oauthClientId: clientId,
      redirectHost: "claude.ai",
      name: "Claude",
      revokedAt: null,
    });
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "oauth_app.connect")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "api_token",
      entityId: res.id,
      actorType: "user",
      surface: "ui",
    });
    expect(JSON.stringify(audits[0])).not.toMatch(/token_?hash/i);
  });
  it("Read only gives [read]; Read and write gives [read, write]; autonomy sets full_autonomy only with write", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const read = await approveConnection(db, {
      userId: m.userId,
      orgId,
      ...app(await makeClient(db), { access: "read", fullAutonomy: true }),
    });
    const rw = await approveConnection(db, {
      userId: m.userId,
      orgId,
      ...app(await makeClient(db), { fullAutonomy: true }),
    });
    const rwPlain = await approveConnection(db, {
      userId: m.userId,
      orgId,
      ...app(await makeClient(db)),
    });
    const byId = new Map((await rowsOf(orgId, m.userId)).map((r) => [r.id, r]));
    expect(byId.get(read.id)).toMatchObject({ scopes: ["read"], mode: "human_in_the_loop" });
    expect(byId.get(rw.id)).toMatchObject({ scopes: ["read", "write"], mode: "full_autonomy" });
    expect(byId.get(rwPlain.id)).toMatchObject({
      scopes: ["read", "write"],
      mode: "human_in_the_loop",
    });
  });
  it("reconnecting updates the live row in place (same id) and audits with before and after", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const first = await approveConnection(db, { userId: m.userId, orgId, ...app(clientId) });
    const second = await approveConnection(db, {
      userId: m.userId,
      orgId,
      ...app(clientId, { access: "read" }),
    });
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await rowsOf(orgId, m.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(["read"]);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "oauth_app.connect")))
      .orderBy(auditLog.id);
    expect(audits).toHaveLength(2);
    expect(audits[1]!.before).toMatchObject({ scopes: ["read", "write"] });
    expect(audits[1]!.after).toMatchObject({ scopes: ["read"] });
  });
  it("after the row is revoked, approving inserts a NEW row and the revoked one stays revoked", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const first = await approveConnection(db, { userId: m.userId, orgId, ...app(clientId) });
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, first.id));
    const second = await approveConnection(db, { userId: m.userId, orgId, ...app(clientId) });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    const rows = await rowsOf(orgId, m.userId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.id)!.revokedAt).not.toBeNull();
    expect(rows.find((r) => r.id === second.id)!.revokedAt).toBeNull();
  });
  it("a client_viewer asking for write is FORBIDDEN, and read is fine", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "client_viewer");
    const clientId = await makeClient(db);
    await expect(
      approveConnection(db, { userId: m.userId, orgId, ...app(clientId) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rowsOf(orgId, m.userId)).toHaveLength(0);
    await approveConnection(db, { userId: m.userId, orgId, ...app(clientId, { access: "read" }) });
    expect(await rowsOf(orgId, m.userId)).toHaveLength(1);
  });
  it("a person with no membership in the org is refused (FORBIDDEN)", async () => {
    const orgId = await makeOrg(db);
    const outsider = await makeUser(db);
    await expect(
      approveConnection(db, { userId: outsider, orgId, ...app(await makeClient(db)) }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("the database refuses a second live row for the same person, org and app", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    await approveConnection(db, { userId: m.userId, orgId, ...app(clientId) });
    const dup = db
      .insert(apiTokens)
      .values({
        orgId,
        userId: m.userId,
        name: "dup",
        scopes: ["read"],
        tokenHash: "x".repeat(64),
        oauthClientId: clientId,
      });
    await expect(dup).rejects.toSatisfy((e: unknown) => {
      for (let c: unknown = e, i = 0; c && i < 5; i++, c = (c as { cause?: unknown }).cause) {
        if ((c as { code?: unknown }).code === "23505") return true;
      }
      return false;
    });
  });
});

async function seedGrants(clientId: string, userId: string, orgId: string) {
  await db
    .insert(oauthConsents)
    .values({ id: randomUUID(), clientId, userId, referenceId: orgId, scopes: ["mcp:read"] });
  await db
    .insert(oauthRefreshTokens)
    .values({
      id: randomUUID(),
      token: randomUUID(),
      clientId,
      userId,
      referenceId: orgId,
      scopes: ["mcp:read"],
    });
}
const countConsents = async (userId: string, orgId: string) =>
  (
    await db
      .select()
      .from(oauthConsents)
      .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.referenceId, orgId)))
  ).length;
const liveRefresh = async (userId: string, orgId: string) =>
  (
    await db
      .select()
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.referenceId, orgId)))
  ).filter((r) => r.revoked === null).length;

describe("endOAuthGrants", () => {
  it("deletes the consents and revokes the refresh tokens of that person in that org; another org's survive", async () => {
    const orgA = await makeOrg(db);
    const orgB = await makeOrg(db);
    const userId = await makeUser(db);
    const clientId = await makeClient(db);
    await seedGrants(clientId, userId, orgA);
    await seedGrants(clientId, userId, orgB);
    const out = await db.transaction((tx) => endOAuthGrants(tx, { userId, orgId: orgA }));
    expect(out).toEqual({ consents: 1, refreshTokens: 1, accessTokens: 0 });
    expect(await countConsents(userId, orgA)).toBe(0);
    expect(await liveRefresh(userId, orgA)).toBe(0);
    expect(await countConsents(userId, orgB)).toBe(1);
    expect(await liveRefresh(userId, orgB)).toBe(1);
  });
  it("with clientId, only that app's grants end", async () => {
    const orgId = await makeOrg(db);
    const userId = await makeUser(db);
    const c1 = await makeClient(db);
    const c2 = await makeClient(db);
    await seedGrants(c1, userId, orgId);
    await seedGrants(c2, userId, orgId);
    const out = await db.transaction((tx) => endOAuthGrants(tx, { userId, orgId, clientId: c1 }));
    expect(out).toEqual({ consents: 1, refreshTokens: 1, accessTokens: 0 });
    expect(await countConsents(userId, orgId)).toBe(1);
    expect(await liveRefresh(userId, orgId)).toBe(1);
  });
});

describe("members.remove", () => {
  it("revokes the person's connection and ends their OAuth grants in that org", async () => {
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const member = await makeMember(db, orgId, "manager");
    const clientId = await makeClient(db);
    const conn = await approveConnection(db, { userId: member.userId, orgId, ...app(clientId) });
    await seedGrants(clientId, member.userId, orgId);
    const [mem] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, member.userId)));
    await executeAction(db, owner.actor, "members.remove", { membershipId: mem!.id });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, conn.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(await countConsents(member.userId, orgId)).toBe(0);
    expect(await liveRefresh(member.userId, orgId)).toBe(0);
  });
});

describe("connected apps (actions)", () => {
  const connect = (userId: string, orgId: string, clientId: string, over: Record<string, unknown> = {}) =>
    approveConnection(db, { userId, orgId, ...app(clientId, over) });
  const list = async (actor: Actor) => (await executeAction(db, actor, "connectedApps.list", {}) as { apps: { id: string; name: string; redirectHost: string | null; ownerUserId: string; access: string; fullAutonomy: boolean; lastUsedAt: string | null }[] }).apps;
  const asToken = (actor: Actor): Actor => ({ ...actor, surface: "mcp", actorType: "api_token", apiTokenId: randomUUID() });

  it("canary: connectedApps.list shows the caller's live connection with app, host, access, autonomy and last used", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const conn = await connect(m.userId, orgId, clientId, { fullAutonomy: true });
    const apps = await list(m.actor);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: conn.id, name: "Claude", redirectHost: "claude.ai", ownerUserId: m.userId, access: "write", fullAutonomy: true, lastUsedAt: null });
  });
  it("lists no ordinary tokens and no disconnected apps", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    await db.transaction((tx) => createApiTokenFor(tx, m.actor, "plain", async () => {}));
    const gone = await connect(m.userId, orgId, await makeClient(db));
    await executeAction(db, m.actor, "connectedApps.disconnect", { id: gone.id });
    expect(await list(m.actor)).toEqual([]);
  });
  it("an owner sees every member's connections; a member sees only their own", async () => {
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const member = await makeMember(db, orgId, "manager");
    const clientId = await makeClient(db);
    await connect(owner.userId, orgId, clientId);
    await connect(member.userId, orgId, clientId);
    expect((await list(owner.actor)).map((a) => a.ownerUserId).sort()).toEqual([owner.userId, member.userId].sort());
    expect((await list(member.actor)).map((a) => a.ownerUserId)).toEqual([member.userId]);
  });
  it("connectedApps.update changes access and autonomy, audits oauth_app.update, and the next verify uses it", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const conn = await connect(m.userId, orgId, await makeClient(db));
    const out = (await executeAction(db, m.actor, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: false })) as { app: { access: string } };
    expect(out.app.access).toBe("read");
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, conn.id));
    expect(row!.scopes).toEqual(["read"]);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "oauth_app.update")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toMatchObject({ scopes: ["read", "write"] });
    expect(audits[0]!.after).toMatchObject({ scopes: ["read"] });
    // the next call (verify builds the actor from the row) sees read only
    expect((await actorFromTokenRow(db, row!)).scopes).toEqual(["read"]);
    // full autonomy needs write
    const again = (await executeAction(db, m.actor, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: true })) as { app: { fullAutonomy: boolean } };
    expect(again.app.fullAutonomy).toBe(false);
  });
  it("connectedApps.update is refused for an api_token caller, before any proposal (preview refuses)", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const conn = await connect(m.userId, orgId, await makeClient(db));
    const caller = asToken(m.actor);
    await expect(executeAction(db, caller, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: false })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/cannot/) });
    await expect(executeToolCall(db, caller, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: false, dryRun: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(executeToolCall(db, caller, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, conn.id));
    expect(row!.scopes).toEqual(["read", "write"]);
  });
  it("connectedApps.update on someone else's connection is NOT_FOUND, even for an owner", async () => {
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const member = await makeMember(db, orgId, "manager");
    const conn = await connect(member.userId, orgId, await makeClient(db));
    await expect(executeAction(db, owner.actor, "connectedApps.update", { id: conn.id, access: "read", fullAutonomy: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("connectedApps.disconnect revokes the row, ends the grants (consent deleted, refresh revoked) and audits oauth_app.disconnect", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const conn = await connect(m.userId, orgId, clientId);
    await seedGrants(clientId, m.userId, orgId);
    expect(await executeAction(db, m.actor, "connectedApps.disconnect", { id: conn.id })).toEqual({ disconnected: true });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, conn.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(await countConsents(m.userId, orgId)).toBe(0);
    expect(await liveRefresh(m.userId, orgId)).toBe(0);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "oauth_app.disconnect")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(conn.id);
  });
  it("after disconnect, approving again inserts a new row (the consent page is shown again: no consent left)", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const clientId = await makeClient(db);
    const conn = await connect(m.userId, orgId, clientId);
    await seedGrants(clientId, m.userId, orgId);
    await executeAction(db, m.actor, "connectedApps.disconnect", { id: conn.id });
    expect(await countConsents(m.userId, orgId)).toBe(0);
    const again = await connect(m.userId, orgId, clientId);
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(conn.id);
  });
  it("an owner may disconnect a member's connection; a member may not disconnect someone else's (FORBIDDEN)", async () => {
    const orgId = await makeOrg(db);
    const owner = await makeMember(db, orgId, "owner");
    const member = await makeMember(db, orgId, "manager");
    const other = await makeMember(db, orgId, "manager");
    const clientId = await makeClient(db);
    const ownersConn = await connect(owner.userId, orgId, clientId);
    const membersConn = await connect(member.userId, orgId, clientId);
    await expect(executeAction(db, other.actor, "connectedApps.disconnect", { id: membersConn.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(executeAction(db, member.actor, "connectedApps.disconnect", { id: ownersConn.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await executeAction(db, owner.actor, "connectedApps.disconnect", { id: membersConn.id })).toEqual({ disconnected: true });
  });
  it("an ordinary token id is NOT_FOUND for update and disconnect", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const { apiToken } = await db.transaction((tx) => createApiTokenFor(tx, m.actor, "plain", async () => {}));
    await expect(executeAction(db, m.actor, "connectedApps.update", { id: apiToken.id, access: "read", fullAutonomy: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(executeAction(db, m.actor, "connectedApps.disconnect", { id: apiToken.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, apiToken.id));
    expect(row!.revokedAt).toBeNull();
  });
  it("another org's connection is NOT_FOUND", async () => {
    const orgA = await makeOrg(db);
    const orgB = await makeOrg(db);
    const a = await makeMember(db, orgA, "owner");
    const b = await makeMember(db, orgB, "owner");
    const conn = await connect(b.userId, orgB, await makeClient(db));
    await expect(executeAction(db, a.actor, "connectedApps.disconnect", { id: conn.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("disconnecting twice is CONFLICT", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const conn = await connect(m.userId, orgId, await makeClient(db));
    await executeAction(db, m.actor, "connectedApps.disconnect", { id: conn.id });
    await expect(executeAction(db, m.actor, "connectedApps.disconnect", { id: conn.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("apiTokens.revoke refuses a connected app (CONFLICT naming Disconnect) and leaves it live", async () => {
    const orgId = await makeOrg(db);
    const m = await makeMember(db, orgId, "owner");
    const conn = await connect(m.userId, orgId, await makeClient(db));
    await expect(executeAction(db, m.actor, "apiTokens.revoke", { id: conn.id })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Disconnect/) });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, conn.id));
    expect(row!.revokedAt).toBeNull();
  });
});
