import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DIRECTORY_EXCLUDED, approveConnection, createApiToken, oauthAddresses, protectedResourceMetadata, toolNameFor } from "@opengmb/core";
import { apiTokens, createDb, jwks, mcpProposals, memberships, oauthClients, organizations, users } from "@opengmb/db";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addresses = oauthAddresses({ BETTER_AUTH_URL: "https://app.example.test" })!;
const RESOURCE = addresses.resource;

let kid: string;
let privateKey: CryptoKey;
// expiresAt in the past: the jwt plugin only signs with a live key, so this test key (its private half is junk) can never
// be picked for signing by a flow test running against the same database.
beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  kid = randomUUID();
  privateKey = pair.privateKey;
  await db.insert(jwks).values({ id: kid, publicKey: JSON.stringify(await exportJWK(pair.publicKey)), privateKey: "test-only-not-used", alg: "EdDSA", crv: "Ed25519", expiresAt: new Date(0) });
});
afterAll(() => sql.end());

type Conn = { userId: string; orgId: string; clientId: string; rowId: string; email: string };
async function connection(access: "read" | "write" = "write"): Promise<Conn> {
  const [o] = await db.insert(organizations).values({ name: `oauth-${uniq()}` }).returning();
  const userId = `u-${uniq()}`;
  const email = `${userId}@example.test`;
  await db.insert(users).values({ id: userId, name: "T", email, twoFactorEnabled: true });
  await db.insert(memberships).values({ orgId: o!.id, userId, role: "owner" });
  const clientId = `client-${uniq()}`;
  await db.insert(oauthClients).values({ id: randomUUID(), clientId, name: "Claude", redirectUris: ["https://claude.ai/cb"] });
  const { id } = await approveConnection(db, { userId, orgId: o!.id, clientId, clientName: "Claude", redirectHost: "claude.ai", access, fullAutonomy: false });
  return { userId, orgId: o!.id, clientId, rowId: id, email };
}
const jwtFor = (c: Conn) =>
  new SignJWT({ client_id: c.clientId, azp: c.clientId, org_id: c.orgId, scope: "mcp:read mcp:write offline_access" })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "at+jwt" })
    .setIssuer(addresses.issuer)
    .setAudience(RESOURCE)
    .setSubject(c.userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

const start = (rateLimits: { authFailuresPerMinute: number; requestsPerMinute: number }) =>
  startServer(0, { db, oauth: addresses, rateLimits: { ...rateLimits, proxyHops: 1 } });
const list = (port: number, path: string, token: string | undefined, ip = "203.0.113.1") =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-forwarded-for": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("/mcp with OAuth", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await start({ authFailuresPerMinute: 1000, requestsPerMinute: 100_000 });
  });
  afterAll(() => server.close());

  it("canary: a valid JWT runs tools/list (200, tools listed)", async () => {
    const c = await connection();
    const res = await list(server.port, "/mcp", await jwtFor(c));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it('no token on /mcp: 401 with WWW-Authenticate: Bearer resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/mcp"', async () => {
    const res = await list(server.port, "/mcp", undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/mcp"');
  });

  it("no token on /v1: 401 with the bare Bearer header (unchanged)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/me`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("a JWT on /v1 is refused (401), even a valid one", async () => {
    const c = await connection();
    const token = await jwtFor(c);
    expect((await list(server.port, "/mcp", token)).status).toBe(200); // control: the same token works on /mcp
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/me`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("an sgmb_ token on /mcp still works (the old path)", async () => {
    const c = await connection();
    const { token } = await createApiToken(db, { email: c.email });
    expect((await list(server.port, "/mcp", token)).status).toBe(200);
  });

  it("an OAuth connection gets the directory profile; an sgmb_ token gets every tool", async () => {
    const c = await connection();
    const names = async (token: string) =>
      ((await (await list(server.port, "/mcp", token)).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    const viaOAuth = await names(await jwtFor(c));
    const { token } = await createApiToken(db, { email: c.email });
    const viaToken = await names(token);
    expect(viaToken).toContain("postImages_generate"); // canary: the full set still has it
    expect(viaOAuth).not.toContain("postImages_generate");
    expect(viaOAuth).not.toContain("posts_approve");
    expect(viaOAuth).toContain("reviews_list_unreplied");
    const excluded = Object.keys(DIRECTORY_EXCLUDED).map(toolNameFor).sort();
    expect(excluded.length).toBeGreaterThan(0); // fail on zero
    expect(viaToken.filter((n) => !viaOAuth.includes(n)).sort()).toEqual(excluded);
    console.log(`oauth: ${viaOAuth.length} tools, sgmb_: ${viaToken.length}, excluded: ${excluded.length}`);
  });

  it("an OAuth connection calling an excluded tool by name is refused; the same call with an sgmb_ token is not", async () => {
    const c = await connection();
    const call = async (token: string) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.1", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "postImages_generate", arguments: {} } }),
      });
      const body = (await res.json()) as { error?: { message: string }; result?: { isError?: boolean; content?: { text: string }[] } };
      return { isError: !!body.error || !!body.result?.isError, text: body.error?.message ?? body.result?.content?.map((x) => x.text).join(" ") ?? "" };
    };
    const viaOAuth = await call(await jwtFor(c));
    expect(viaOAuth.isError).toBe(true);
    expect(viaOAuth.text).toMatch(/not found|unknown tool/i);
    const { token } = await createApiToken(db, { email: c.email });
    const viaToken = await call(token);
    expect(viaToken.text).not.toMatch(/not found|unknown tool/i); // canary: the tool exists for a token (it fails on its input or access instead)
  });

  it("an opaque (non-JWT) bearer on /mcp is 401", async () => {
    expect((await list(server.port, "/mcp", "opaque-access-token-without-resource", "203.0.113.20")).status).toBe(401);
  });

  it("after Disconnect (row revoked) the same JWT gets 401", async () => {
    const c = await connection();
    const token = await jwtFor(c);
    expect((await list(server.port, "/mcp", token)).status).toBe(200);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, c.rowId));
    expect((await list(server.port, "/mcp", token)).status).toBe(401);
  });

  it("a two-phase write over OAuth stores a pending proposal owned by the connection's row", async () => {
    const c = await connection();
    const client = new Client({ name: "oauth", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${await jwtFor(c)}` } },
      }),
    );
    const res = await client.callTool({ name: "workspaces_create", arguments: { name: `oauth-ws-${uniq()}` } });
    expect(res.isError).toBeFalsy();
    const proposalId = (res.structuredContent as { proposalId: string }).proposalId;
    const [p] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, proposalId));
    expect(p).toMatchObject({ tokenId: c.rowId, status: "pending", orgId: c.orgId });
    const listed = await client.callTool({ name: toolNameFor("mcp.proposals.list"), arguments: {} });
    expect(JSON.stringify(listed.structuredContent ?? listed.content)).toContain(proposalId);
    await client.close();
  });

  it("the protected resource metadata document is valid RFC 9728 per the MCP SDK schema", () => {
    const doc = OAuthProtectedResourceMetadataSchema.parse(protectedResourceMetadata(addresses));
    expect(doc.resource).toBe(addresses.resource);
    expect(doc.authorization_servers?.[0]).toBe(addresses.issuer);
  });
});

describe("/mcp limits with OAuth", () => {
  it("a request with no Authorization header on /mcp does not count toward the per-IP auth-failure limiter; a present-but-invalid token still does", async () => {
    const server = await start({ authFailuresPerMinute: 3, requestsPerMinute: 100_000 });
    try {
      const c = await connection();
      const good = await jwtFor(c);
      for (let i = 0; i < 6; i++) expect((await list(server.port, "/mcp", undefined, "198.51.100.30")).status).toBe(401); // never 429
      expect((await list(server.port, "/mcp", good, "198.51.100.30")).status).toBe(200);
      expect((await list(server.port, "/mcp", "not.a.jwt", "198.51.100.31")).status).toBe(401);
      expect((await list(server.port, "/mcp", "sgmb_wrong", "198.51.100.31")).status).toBe(401);
      expect((await list(server.port, "/mcp", "sgmb_wrong", "198.51.100.31")).status).toBe(401);
      expect((await list(server.port, "/mcp", "sgmb_wrong", "198.51.100.31")).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it("each connection draws on its own request budget (keyed by the api_tokens row id)", async () => {
    const server = await start({ authFailuresPerMinute: 1000, requestsPerMinute: 2 });
    try {
      const a = await jwtFor(await connection());
      const b = await jwtFor(await connection());
      const ip = "198.51.100.40";
      expect([(await list(server.port, "/mcp", a, ip)).status, (await list(server.port, "/mcp", a, ip)).status, (await list(server.port, "/mcp", a, ip)).status]).toEqual([200, 200, 429]);
      expect((await list(server.port, "/mcp", b, ip)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
