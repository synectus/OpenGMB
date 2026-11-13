import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { eq } from "drizzle-orm";
import { apiTokens, createDb, jwks, memberships, oauthClients, organizations, users, workspaces } from "@opengmb/db";
import type { Db } from "@opengmb/db";
import { generateApiToken, hashApiToken } from "../apiTokens";
import { executeAction } from "../executor";
import type { Role } from "../permissions";
import { approveConnection } from "./connections";
import { IAT_SKEW_SECONDS, verifyOAuthAccessToken } from "./verify";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const ISSUER = "https://app.example.test";
const RESOURCE = "https://app.example.test/mcp";
const addresses = { issuer: ISSUER, resource: RESOURCE, authorizationServerMetadataUrl: "", protectedResourceMetadataUrl: "" };
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let kid: string;
let privateKey: CryptoKey;
// expiresAt in the past: the jwt plugin only signs with a live key, so this test key (its private half is junk) can never
// be picked for signing by a flow test running against the same database.
beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  kid = randomUUID();
  privateKey = pair.privateKey;
  await db.insert(jwks).values({
    id: kid,
    publicKey: JSON.stringify(await exportJWK(pair.publicKey)),
    privateKey: "test-only-not-used",
    alg: "EdDSA",
    crv: "Ed25519",
    expiresAt: new Date(0),
  });
});

type Conn = { userId: string; orgId: string; clientId: string; rowId: string };
async function connection(role: Role = "owner", access: "read" | "write" = "write", d: Db = db): Promise<Conn> {
  const [o] = await d.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const userId = `u-${uniq()}`;
  await d.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
  if (role === "client_viewer" || role === "client_approver") {
    const [w] = await d.insert(workspaces).values({ orgId: o!.id, name: `ws-${uniq()}` }).returning();
    await d.insert(memberships).values({ orgId: o!.id, userId, role, workspaceId: w!.id });
  } else {
    await d.insert(memberships).values({ orgId: o!.id, userId, role });
  }
  const clientId = `client-${uniq()}`;
  await d.insert(oauthClients).values({ id: randomUUID(), clientId, name: "Claude", redirectUris: ["https://claude.ai/cb"] });
  // client_viewer cannot ask for write; ask for read and set the row below
  const { id } = await approveConnection(d, { userId, orgId: o!.id, clientId, clientName: "Claude", redirectHost: "claude.ai", access: role === "client_viewer" ? "read" : access, fullAutonomy: false });
  return { userId, orgId: o!.id, clientId, rowId: id };
}
async function reconnect(c: Conn) {
  return (await approveConnection(db, { userId: c.userId, orgId: c.orgId, clientId: c.clientId, clientName: "Claude", redirectHost: "claude.ai", access: "write", fullAutonomy: false })).id;
}

type Over = { iss?: string; aud?: string | string[]; exp?: string | number; iat?: number; typ?: string; key?: CryptoKey; kid?: string; org?: string | null; client?: string | null; sub?: string };
async function jwtFor(c: Conn, o: Over = {}) {
  const claims: Record<string, unknown> = { scope: "mcp:read mcp:write offline_access" };
  const client = o.client === undefined ? c.clientId : o.client;
  if (client !== null) {
    claims.client_id = client;
    claims.azp = client;
  }
  const org = o.org === undefined ? c.orgId : o.org;
  if (org !== null) claims.org_id = org;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: o.kid ?? kid, typ: o.typ ?? "at+jwt" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? RESOURCE)
    .setSubject(o.sub ?? c.userId)
    .setIssuedAt(o.iat)
    .setExpirationTime(o.exp ?? "1h")
    .sign(o.key ?? privateKey);
}
const rejects401 = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

describe("verifyOAuthAccessToken", () => {
  it("canary: a valid token gives the row's api_token actor (surface mcp, apiTokenId = row id, scopes and mode from the row)", async () => {
    const c = await connection();
    const actor = await verifyOAuthAccessToken(db, await jwtFor(c), addresses);
    expect(actor).toMatchObject({ userId: c.userId, orgId: c.orgId, role: "owner", surface: "mcp", actorType: "api_token", apiTokenId: c.rowId, scopes: ["read", "write"], tokenMode: "human_in_the_loop" });
  });

  it("updates last_used_at on the row", async () => {
    const c = await connection();
    const before = (await db.select().from(apiTokens).where(eq(apiTokens.id, c.rowId)))[0]!;
    expect(before.lastUsedAt).toBeNull();
    await verifyOAuthAccessToken(db, await jwtFor(c), addresses);
    const after = (await db.select().from(apiTokens).where(eq(apiTokens.id, c.rowId)))[0]!;
    expect(after.lastUsedAt).toBeInstanceOf(Date);
  });

  it("expired: 401 (UNAUTHENTICATED)", async () => {
    const c = await connection();
    const t = Math.floor(Date.now() / 1000);
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { iat: t - 7200, exp: t - 3600 }), addresses));
  });

  it("wrong audience: 401, including an array audience with an extra entry", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { aud: "https://other.example.test/mcp" }), addresses));
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { aud: [RESOURCE, "x"] }), addresses));
  });

  it("wrong issuer: 401", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { iss: "https://evil.example.test" }), addresses));
  });

  it("bad signature: 401", async () => {
    const c = await connection();
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { key: other.privateKey }), addresses));
  });

  it("unknown kid: 401", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { kid: randomUUID() }), addresses));
  });

  it("a kid that is not a plain id (NUL byte, object, too long) is 401, not a database error", async () => {
    // Unsigned: the header alone must be refused before any key lookup reaches Postgres (a NUL byte there is a 500).
    const forged = (header: Record<string, unknown>) => `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.x`;
    for (const kid of ["\u0000", { a: 1 }, ["k"], "k".repeat(129), "has space"]) {
      await rejects401(verifyOAuthAccessToken(db, forged({ alg: "EdDSA", typ: "at+jwt", kid }), addresses));
    }
  });

  it("not an access token (typ JWT, an ID token shape): 401", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { typ: "JWT" }), addresses));
  });

  it("no org_id claim or no client id: 401", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { org: null }), addresses));
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { client: null }), addresses));
  });

  it('an org_id that is not a uuid (the "unchosen" sentinel) is 401, not a database error', async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { org: "unchosen" }), addresses));
  });

  it("revoked row: 401 at once, although the token has not expired", async () => {
    const c = await connection();
    const token = await jwtFor(c);
    await verifyOAuthAccessToken(db, token, addresses);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, c.rowId));
    await rejects401(verifyOAuthAccessToken(db, token, addresses));
  });

  it("a token minted before Disconnect and reconnect is refused; the new connection's token works", async () => {
    const c = await connection();
    const now = Math.floor(Date.now() / 1000);
    await db.update(apiTokens).set({ createdAt: new Date((now - 120) * 1000) }).where(eq(apiTokens.id, c.rowId));
    const oldToken = await jwtFor(c, { iat: now - 60 });
    await verifyOAuthAccessToken(db, oldToken, addresses); // fine while the first row is live
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, c.rowId));
    const newId = await reconnect(c);
    expect(newId).not.toBe(c.rowId);
    const [b] = await db.select().from(apiTokens).where(eq(apiTokens.id, newId));
    const bSeconds = Math.floor(b!.createdAt.getTime() / 1000);
    // the new row's created_at is later than the old token's iat (60 s ago): refused although unexpired and a live row matches
    await rejects401(verifyOAuthAccessToken(db, oldToken, addresses));
    expect((await verifyOAuthAccessToken(db, await jwtFor(c, { iat: bSeconds }), addresses)).apiTokenId).toBe(newId);
    // skew: within IAT_SKEW_SECONDS accepted, well before refused
    expect(IAT_SKEW_SECONDS).toBe(5);
    expect((await verifyOAuthAccessToken(db, await jwtFor(c, { iat: bSeconds - 3 }), addresses)).apiTokenId).toBe(newId);
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { iat: bSeconds - 60 }), addresses));
  });

  it("missing row (another org in the claim): 401", async () => {
    const c = await connection();
    const other = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c, { org: other.orgId }), addresses));
  });

  it("OAuth off (addresses null): 401", async () => {
    const c = await connection();
    await rejects401(verifyOAuthAccessToken(db, await jwtFor(c), null));
  });

  it("a client_viewer's connection is read-only whatever the row says", async () => {
    const c = await connection("client_viewer");
    await db.update(apiTokens).set({ scopes: ["read", "write"] }).where(eq(apiTokens.id, c.rowId));
    const actor = await verifyOAuthAccessToken(db, await jwtFor(c), addresses);
    expect(actor.scopes).toEqual(["read"]);
  });

  it("access edited to Read only refuses a write on the next call although the token says mcp:write", async () => {
    const c = await connection();
    const token = await jwtFor(c);
    const ok = await verifyOAuthAccessToken(db, token, addresses);
    expect(ok.scopes).toEqual(["read", "write"]);
    await db.update(apiTokens).set({ scopes: ["read"] }).where(eq(apiTokens.id, c.rowId));
    const actor = await verifyOAuthAccessToken(db, token, addresses);
    expect(actor.scopes).toEqual(["read"]);
    await expect(executeAction(db, actor, "workspaces.create", { name: `ws-${uniq()}` })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/read-only/) });
  });

  it("an sgmb_ token is not accepted here", async () => {
    const c = await connection();
    const sgmb = generateApiToken();
    await db.insert(apiTokens).values({ orgId: c.orgId, userId: c.userId, name: "plain", scopes: ["read", "write"], tokenHash: hashApiToken(sgmb) });
    await rejects401(verifyOAuthAccessToken(db, sgmb, addresses));
  });
});
