import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apiTokens, createDb, memberships, oauthClients, oauthConsents, oauthRefreshTokens, organizations, users } from "@opengmb/db";
import { approveConnection } from "./connections";
import { OAUTH_CLIENT_SWEEP, sweepUnusedOAuthClients } from "./sweep";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 86_400_000;
const now = new Date();

async function seedClient(ageDays: number) {
  const clientId = `sweep-${uniq()}`;
  await db.insert(oauthClients).values({ id: randomUUID(), clientId, name: "Sweep", redirectUris: ["https://claude.ai/cb"], createdAt: new Date(now.getTime() - ageDays * DAY) });
  return clientId;
}
async function person() {
  const [o] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const userId = `u-${uniq()}`;
  await db.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
  await db.insert(memberships).values({ orgId: o!.id, userId, role: "owner" });
  return { orgId: o!.id, userId };
}
const exists = async (ids: string[]) => (await db.select({ c: oauthClients.clientId }).from(oauthClients).where(inArray(oauthClients.clientId, ids))).map((r) => r.c);

describe("sweepUnusedOAuthClients", () => {
  it("canary: deletes a client older than 30 days that no api_tokens row names, with its consents and refresh tokens", async () => {
    const id = await seedClient(OAUTH_CLIENT_SWEEP.unusedDays + 1);
    const p = await person();
    await db.insert(oauthConsents).values({ id: randomUUID(), clientId: id, userId: p.userId, referenceId: p.orgId, scopes: ["mcp:read"] });
    await db.insert(oauthRefreshTokens).values({ id: randomUUID(), token: randomUUID(), clientId: id, userId: p.userId, referenceId: p.orgId, scopes: ["mcp:read"] });
    const r = await sweepUnusedOAuthClients(db, { now, clientIds: [id] });
    expect(r).toEqual({ checked: 1, deleted: 1 });
    expect(await exists([id])).toEqual([]);
    expect(await db.select().from(oauthConsents).where(eq(oauthConsents.clientId, id))).toHaveLength(0);
    expect(await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.clientId, id))).toHaveLength(0);
  });
  it("keeps a client with a live row, and one with only a revoked row", async () => {
    const live = await seedClient(60);
    const revoked = await seedClient(60);
    const p = await person();
    await approveConnection(db, { userId: p.userId, orgId: p.orgId, clientId: live, clientName: "A", redirectHost: "claude.ai", access: "read", fullAutonomy: false });
    const { id } = await approveConnection(db, { userId: p.userId, orgId: p.orgId, clientId: revoked, clientName: "B", redirectHost: "claude.ai", access: "read", fullAutonomy: false });
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
    const r = await sweepUnusedOAuthClients(db, { now, clientIds: [live, revoked] });
    expect(r).toEqual({ checked: 2, deleted: 0 });
    expect((await exists([live, revoked])).sort()).toEqual([live, revoked].sort());
  });
  it("keeps a client registered less than 30 days ago", async () => {
    const id = await seedClient(OAUTH_CLIENT_SWEEP.unusedDays - 1);
    expect(await sweepUnusedOAuthClients(db, { now, clientIds: [id] })).toEqual({ checked: 1, deleted: 0 });
    expect(await exists([id])).toEqual([id]);
  });
  it("prints how many it checked and deleted", async () => {
    const ids = [await seedClient(90), await seedClient(90), await seedClient(1)];
    const r = await sweepUnusedOAuthClients(db, { now, clientIds: ids });
    expect(r).toEqual({ checked: ids.length, deleted: 2 });
    expect(await exists(ids)).toEqual([ids[2]]);
  });
});
