import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { hashPassword } from "better-auth/crypto";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { and, eq } from "drizzle-orm";
import * as dbSchema from "@opengmb/db";
import { accounts, createDb, memberships, oauthClients, oauthConsents, oauthRefreshTokens, jwks, organizations, users } from "@opengmb/db";
import { getTableColumns } from "drizzle-orm";
import { createAuth } from "../auth";
import { rememberOrgChoice, clearOrgChoice } from "./org-choice";
import { OAUTH_DISABLED_PATHS, OAUTH_SERVER_ONLY_PATHS, OAUTH_USED_PATHS, REDIRECT_URI_PATHS } from "./provider";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const RESOURCE = `${BASE}/mcp`;
const auth = createAuth(db, {
  secret: "test-secret-test-secret-test-secret-123",
  baseURL: BASE,
  enforceOriginCheck: true,
  // Limiter off: these requests send no x-forwarded-for, so better-auth 1.7.7 puts them all in one bucket per path
  // (/two-factor/* allows 8 a minute, sign-up 10 an hour) and the spike would see 429s it could misread as a no-go.
  // Task 1.8 tests the registration limit separately, with an x-forwarded-for.
  rateLimitEnabled: false,
  oauthEnv: { BETTER_AUTH_URL: BASE },
});

/** Browser-like jar: sends Origin and cookies. */
class Browser {
  jar = new Map<string, string>();
  cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  private keep(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  async get(pathAndQuery: string) {
    return this.keep(await auth.handler(new Request(`${BASE}/api/auth${pathAndQuery}`, { headers: { cookie: this.cookie() }, redirect: "manual" })));
  }
  async post(path: string, body: unknown) {
    const res = this.keep(
      await auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", origin: BASE, cookie: this.cookie() },
          body: JSON.stringify(body),
        }),
      ),
    );
    return { res, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  }
}

/** Server-to-server: no Origin, no cookie (claude.ai's backend). */
async function server(path: string, body: Record<string, string> | object, form = false) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "x-forwarded-for": "203.0.113.7" },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const b64url = (b: Buffer) => b.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "correct-horse-battery-staple";

/** A password user with TOTP on, signed out again. Returns the TOTP secret and the user's single org. */
async function totpUser() {
  const email = `oauth-${uniq()}@example.test`;
  const b = new Browser();
  // Inserted directly, like the owner bootstrap: the community edition has no self-service sign-up, and this test must run in both editions.
  const userId = randomBytes(16).toString("hex");
  await db.insert(users).values({ id: userId, name: "OAuth", email, emailVerified: true });
  await db.insert(accounts).values({ id: randomBytes(16).toString("hex"), accountId: userId, providerId: "credential", userId, password: await hashPassword(PASSWORD) });
  const [org] = await db.insert(organizations).values({ name: `OAuth org ${uniq()}` }).returning();
  await db.insert(memberships).values({ orgId: org!.id, userId, role: "owner" });
  expect((await b.post("/sign-in/email", { email, password: PASSWORD })).res.status).toBe(200);
  const enable = await b.post("/two-factor/enable", { password: PASSWORD });
  const secret = new URL(String(enable.json!.totpURI)).searchParams.get("secret")!;
  expect((await b.post("/two-factor/verify-totp", { code: await generate({ secret, strategy: "totp" }) })).res.status).toBe(200);
  const s = await auth.api.getSession({ headers: new Headers({ cookie: b.cookie() }) });
  const [m] = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, s!.user.id));
  return { email, secret, userId: s!.user.id, orgId: m!.orgId };
}

async function register(redirect: string, extra: object = {}) {
  return server("/oauth2/register", {
    client_name: `Spike ${uniq()}`,
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...extra,
  });
}

describe("OAuth metadata", () => {
  it("issuer equals BETTER_AUTH_URL and the endpoints live under /api/auth (criterion 3)", async () => {
    // auth.handler 404s outside the /api/auth basePath (better-call@1.4.0 router), so call the same helper Task 1.7's route uses.
    const res = await oauthProviderAuthServerMetadata(auth)(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(BASE);
    expect(doc.authorization_endpoint).toBe(`${BASE}/api/auth/oauth2/authorize`);
    expect(doc.token_endpoint).toBe(`${BASE}/api/auth/oauth2/token`);
    expect(doc.registration_endpoint).toBe(`${BASE}/api/auth/oauth2/register`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["mcp:read", "mcp:write", "offline_access"]));
  });
  it("the jwt plugin's /token route is disabled", async () => {
    expect((await new Browser().get("/token")).status).toBe(404);
  });
});

describe("dynamic registration", () => {
  it("a public client with an https redirect registers without Origin or cookie", async () => {
    const r = await register("https://claude.ai/api/mcp/auth_callback");
    expect(r.res.status).toBe(201);
    expect(r.json!.client_id).toEqual(expect.any(String));
    expect(r.json!.client_secret).toBeUndefined();
  });
  it("a loopback redirect without application_type registers (normalised to native)", async () => {
    const r = await register("http://127.0.0.1:53682/callback");
    expect(r.res.status).toBe(201);
    const [c] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, String(r.json!.client_id)));
    expect(c!.applicationType).toBe("native");
  });
  it("http on a public host is refused", async () => {
    expect((await register("http://evil.example.test/cb")).res.status).toBe(400);
  });
});

describe("authorize, TOTP sign-in, consent, token, refresh (criteria 1, 2, 4)", () => {
  it("runs the whole flow and the token carries the org", async () => {
    const u = await totpUser();
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const clientId = String((await register(redirect)).json!.client_id);
    const { verifier, challenge } = pkce();
    const b = new Browser();
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "mcp:read mcp:write offline_access",
      state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
    });

    // 1. Not signed in: redirected to our /sign-in with a signed query.
    const a1 = await b.get(`/oauth2/authorize?${q}`);
    expect(a1.status).toBe(302);
    const login = new URL(a1.headers.get("location")!, BASE);
    expect(login.pathname).toBe("/sign-in");
    expect(login.searchParams.get("sig")).toBeTruthy();
    const oauthQuery = login.search.slice(1);

    // 2. Password step with oauth_query (what oauthProviderClient adds): 2FA challenge, no session yet.
    const pw = await b.post("/sign-in/email", { email: u.email, password: PASSWORD, oauth_query: oauthQuery });
    expect(pw.json!.twoFactorRedirect).toBe(true);

    // 3. TOTP step with the same oauth_query: the plugin's after hook returns the next authorize step.
    const code1 = await generate({ secret: u.secret, strategy: "totp" });
    const t = await b.post("/two-factor/verify-totp", { code: code1, oauth_query: oauthQuery });
    expect(t.res.status).toBe(200);
    expect(t.json!.redirect).toBe(true);
    const consentUrl = new URL(String(t.json!.url), BASE);
    expect(consentUrl.pathname).toBe("/oauth/consent"); // criterion 1: back in the authorize flow after TOTP

    // 4. Consent the way our server action does: remember the org, then call the plugin in-process.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: b.cookie() }) });
    await rememberOrgChoice(db, session!.session.id, u.orgId);
    const consentedRes = (await auth.api.oauth2Consent({
      headers: new Headers({ cookie: b.cookie() }),
      // authorizeEndpoint (called inside consent) refuses a context with no request ("request not found").
      request: new Request(`${BASE}/api/auth/oauth2/consent`, { method: "POST", headers: { cookie: b.cookie() } }),
      body: { accept: true, oauth_query: consentUrl.search.slice(1) },
      asResponse: true, // without it the in-process call returns {} and drops the redirect URL
    })) as Response;
    const consented = (await consentedRes.json()) as { redirect?: boolean; url?: string };
    await clearOrgChoice(db, session!.session.id);
    const back = new URL(String(consented.url));
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(BASE);
    const code = back.searchParams.get("code")!;

    const [consent] = await db.select().from(oauthConsents).where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, u.userId)));
    expect(consent!.referenceId).toBe(u.orgId); // criterion 2, stored side

    // 5. Code exchange, server to server.
    const tok = await server("/oauth2/token", { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: RESOURCE }, true);
    expect(tok.res.status).toBe(200);
    const access = String(tok.json!.access_token);
    expect(decodeProtectedHeader(access)).toMatchObject({ typ: "at+jwt", kid: expect.any(String) });
    const claims = decodeJwt(access);
    expect(claims).toMatchObject({ iss: BASE, aud: RESOURCE, sub: u.userId, client_id: clientId, azp: clientId, org_id: u.orgId }); // criterion 2
    expect(String(claims.scope).split(" ").sort()).toEqual(["mcp:read", "mcp:write", "offline_access"]);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    expect(tok.json!.refresh_token).toEqual(expect.any(String));
    const [key] = await db.select().from(jwks).where(eq(jwks.id, String(decodeProtectedHeader(access).kid)));
    expect(key).toBeTruthy(); // criterion 4: keys written through our adapter

    // 6. Refresh: rotates, keeps the org claim and the audience.
    const ref = await server("/oauth2/token", { grant_type: "refresh_token", refresh_token: String(tok.json!.refresh_token), client_id: clientId, resource: RESOURCE }, true);
    expect(ref.res.status).toBe(200);
    expect(decodeJwt(String(ref.json!.access_token))).toMatchObject({ aud: RESOURCE, org_id: u.orgId, sub: u.userId });
    const [rt] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.clientId, clientId)).limit(1);
    expect(rt!.referenceId).toBe(u.orgId);
    expect(rt!.expiresAt!.getTime() - rt!.createdAt!.getTime()).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });

  it("authorize without PKCE is refused", async () => {
    const clientId = String((await register("https://claude.ai/api/mcp/auth_callback")).json!.client_id);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: RESOURCE, state: "x" });
    const res = await new Browser().get(`/oauth2/authorize?${q}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("a resource other than the MCP URL is refused (invalid_target)", async () => {
    const clientId = String((await register("https://claude.ai/api/mcp/auth_callback")).json!.client_id);
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: "https://other.example.test/api", code_challenge: challenge, code_challenge_method: "S256", state: "x" });
    const res = await new Browser().get(`/oauth2/authorize?${q}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

// ---------------------------------------------------------------------------
// Account choice, consent guard, endpoint inventory, schema mapping (Task 0.7, kept in PR 1)
// ---------------------------------------------------------------------------
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function secondOrg(userId: string): Promise<string> {
  const [o] = await db.insert(organizations).values({ name: `Second ${uniq()}` }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: o!.id, userId, role: "admin" });
  return o!.id;
}

/** Authorize -> sign in (password + TOTP) with the signed query -> the consent page URL. Returns the consent query. */
async function toConsent(b: Browser, u: Awaited<ReturnType<typeof totpUser>>, clientId: string, opts: { resource?: string | null; state?: string } = {}) {
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "mcp:read mcp:write offline_access",
    state: opts.state ?? "s", code_challenge: challenge, code_challenge_method: "S256",
  });
  if (opts.resource !== null) q.set("resource", opts.resource ?? RESOURCE);
  const a = await b.get(`/oauth2/authorize?${q}`);
  const loc = new URL(a.headers.get("location")!, BASE);
  if (loc.pathname !== "/sign-in") return { verifier, location: loc, consentQuery: loc.search.slice(1) };
  const oauthQuery = loc.search.slice(1);
  await b.post("/sign-in/email", { email: u.email, password: PASSWORD, oauth_query: oauthQuery });
  const t = await b.post("/two-factor/verify-totp", { code: await generate({ secret: u.secret, strategy: "totp" }), oauth_query: oauthQuery });
  const next = new URL(String(t.json!.url), BASE);
  return { verifier, location: next, consentQuery: next.search.slice(1) };
}

/** What the consent server action does (apps/web/app/oauth/consent/actions.ts). */
async function approve(b: Browser, orgId: string, consentQuery: string) {
  const session = await auth.api.getSession({ headers: new Headers({ cookie: b.cookie() }) });
  await rememberOrgChoice(db, session!.session.id, orgId);
  try {
    const res = (await auth.api.oauth2Consent({
      headers: new Headers({ cookie: b.cookie() }),
      request: new Request(`${BASE}/api/auth/oauth2/consent`, { method: "POST", headers: { cookie: b.cookie() } }),
      body: { accept: true, oauth_query: consentQuery },
      asResponse: true,
    })) as Response;
    return (await res.json()) as { redirect?: boolean; url?: string };
  } finally {
    await clearOrgChoice(db, session!.session.id);
  }
}

async function exchange(clientId: string, url: string, verifier: string, resource: string | null = RESOURCE) {
  const code = new URL(url).searchParams.get("code")!;
  return server("/oauth2/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...(resource ? { resource } : {}) }, true);
}

describe("account choice (criterion 2)", () => {
  it("a two-org user's chosen org (not the fallback) reaches the consent, the JWT and the refreshed JWT", async () => {
    const u = await totpUser();
    const second = await secondOrg(u.userId);
    const clientId = String((await register(REDIRECT)).json!.client_id);
    const b = new Browser();
    const { verifier, location, consentQuery } = await toConsent(b, u, clientId);
    expect(location.pathname).toBe("/oauth/consent");
    const done = await approve(b, second, consentQuery);
    const tok = await exchange(clientId, String(done.url), verifier);
    expect(tok.res.status).toBe(200);
    const [consent] = await db.select().from(oauthConsents).where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, u.userId)));
    expect(consent!.referenceId).toBe(second);
    expect(second).not.toBe(u.orgId);
    expect(decodeJwt(String(tok.json!.access_token)).org_id).toBe(second);
    const ref = await server("/oauth2/token", { grant_type: "refresh_token", refresh_token: String(tok.json!.refresh_token), client_id: clientId, resource: RESOURCE }, true);
    expect(ref.res.status).toBe(200);
    expect(decodeJwt(String(ref.json!.access_token)).org_id).toBe(second);
  });

  it("the same two-org user authorizing the same client again is sent to the consent page, not straight back with a code", async () => {
    const u = await totpUser();
    await secondOrg(u.userId);
    const clientId = String((await register(REDIRECT)).json!.client_id);
    const b = new Browser();
    const first = await toConsent(b, u, clientId);
    await approve(b, u.orgId, first.consentQuery);
    const again = await toConsent(b, u, clientId, { state: "again" });
    expect(again.location.origin + again.location.pathname).toBe(`${BASE}/oauth/consent`);
  });

  it("a consent posted directly with no stored choice is refused for a two-org user, and a later authorize still lands on the consent page", async () => {
    const u = await totpUser();
    await secondOrg(u.userId);
    const clientId = String((await register(REDIRECT)).json!.client_id);
    const b = new Browser();
    const first = await toConsent(b, u, clientId);
    const direct = await b.post("/oauth2/consent", { accept: true, oauth_query: first.consentQuery });
    expect(direct.res.status).toBe(400);
    expect(direct.json!.error).toBe("invalid_request");
    expect(await db.select().from(oauthConsents).where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, u.userId)))).toHaveLength(0);
    const again = await toConsent(b, u, clientId, { state: "again" });
    expect(again.location.pathname).toBe("/oauth/consent");
  });

  it("a consent posted directly with no stored choice is refused for a one-org user too", async () => {
    const u = await totpUser();
    const clientId = String((await register(REDIRECT)).json!.client_id);
    const b = new Browser();
    const first = await toConsent(b, u, clientId);
    const direct = await b.post("/oauth2/consent", { accept: true, oauth_query: first.consentQuery });
    expect(direct.res.status).toBe(400);
    expect(await db.select().from(oauthConsents).where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, u.userId)))).toHaveLength(0);
    // deny is not refused by the hook
    const deny = await b.post("/oauth2/consent", { accept: false, oauth_query: first.consentQuery });
    expect(deny.res.status).toBe(200);
    expect(String(deny.json!.url)).toContain("error=access_denied");
  });
});

/** Every endpoint object of the installed jwt and oauthProvider plugins, as the running auth instance holds them. */
async function pluginEndpoints() {
  const ctx = await auth.$context;
  const out: { plugin: string; path: string; serverOnly: boolean }[] = [];
  for (const p of ctx.options.plugins ?? []) {
    if (p.id !== "jwt" && p.id !== "oauth-provider") continue;
    for (const e of Object.values((p.endpoints ?? {}) as Record<string, { path?: string; options?: { metadata?: { SERVER_ONLY?: boolean } } }>)) {
      if (e.path) out.push({ plugin: p.id, path: e.path, serverOnly: Boolean(e.options?.metadata?.SERVER_ONLY) });
    }
  }
  return out;
}

describe("plugin endpoint inventory", () => {
  it("disabled and used paths match the plugin's real HTTP endpoints, and each is in exactly one list", async () => {
    const eps = await pluginEndpoints();
    const http = eps.filter((e) => !e.serverOnly).map((e) => e.path);
    const serverOnly = eps.filter((e) => e.serverOnly).map((e) => e.path);
    console.log(`plugin endpoints: ${eps.length}, http: ${http.length}, server-only: ${serverOnly.length}, disabled: ${OAUTH_DISABLED_PATHS.length}, used: ${OAUTH_USED_PATHS.length}`);
    expect(eps.length).toBeGreaterThan(0);
    for (const p of OAUTH_DISABLED_PATHS) expect(http, `disabled path ${p} is not a plugin HTTP endpoint`).toContain(p);
    for (const p of OAUTH_USED_PATHS) expect(http, `used path ${p} is not a plugin HTTP endpoint`).toContain(p);
    for (const p of http) {
      const n = Number(OAUTH_DISABLED_PATHS.includes(p)) + Number(OAUTH_USED_PATHS.includes(p));
      expect(n, `plugin HTTP path ${p} must be in exactly one of OAUTH_DISABLED_PATHS or OAUTH_USED_PATHS`).toBe(1);
    }
    expect([...new Set(serverOnly)].sort()).toEqual([...OAUTH_SERVER_ONLY_PATHS].sort());
  });

  it("every unused plugin endpoint is off, and used ones are not", async () => {
    const u = await totpUser();
    const b = new Browser();
    await b.post("/sign-in/email", { email: u.email, password: PASSWORD });
    await b.post("/two-factor/verify-totp", { code: await generate({ secret: u.secret, strategy: "totp" }) });
    expect(await auth.api.getSession({ headers: new Headers({ cookie: b.cookie() }) })).toBeTruthy();
    let n = 0;
    for (const p of OAUTH_DISABLED_PATHS) {
      expect((await b.get(p)).status, `GET ${p}`).toBe(404);
      expect((await b.post(p, {})).res.status, `POST ${p}`).toBe(404);
      n++;
    }
    console.log(`disabled paths checked: ${n}`);
    expect(n).toBeGreaterThan(0);
    // canary: used paths are not 404
    expect((await b.get("/oauth2/authorize")).status).not.toBe(404);
    expect((await b.post("/oauth2/register", {})).res.status).not.toBe(404);
    // server-only endpoints have no HTTP route at all (a :param one is probed with a concrete value)
    for (const p of OAUTH_SERVER_ONLY_PATHS) {
      const concrete = p.replace(":identifier", "x").replace(":client_id", "y");
      expect((await b.get(concrete)).status, `GET ${concrete}`).toBe(404);
      expect((await b.post(concrete, {})).res.status, `POST ${concrete}`).toBe(404);
    }
  });

  it("every guarded redirect path refuses a bad redirect", async () => {
    const extra = [...REDIRECT_URI_PATHS].filter((p) => p !== "/oauth2/register");
    console.log(`guarded extra paths: ${extra.length}`);
    for (const p of extra) {
      expect((await server(p, { client_name: "x", redirect_uris: ["http://evil.example.test/cb"] })).res.status, p).toBe(400);
    }
  });
});

describe("Better Auth models map to our Drizzle tables", () => {
  type TableMap = Record<string, { modelName: string; fields: Record<string, { fieldName?: string }> }>;
  function check(tables: TableMap) {
    let models = 0, fields = 0, missing = 0;
    const schema = dbSchema as unknown as Record<string, unknown>;
    for (const [key, t] of Object.entries(tables)) {
      models++;
      // usePlural looks a model up as modelName + "s"; core wires the jwt plugin's "jwks" model as the key "jwkss".
      const table = schema[key === "jwks" ? "jwks" : `${t.modelName}s`];
      const cols = table ? Object.keys(getTableColumns(table as never)) : [];
      for (const [fk, f] of Object.entries(t.fields)) {
        fields++;
        if (!cols.includes(f.fieldName ?? fk)) missing++;
      }
      if (!table) missing++;
    }
    return { models, fields, missing };
  }
  it("every model and field exists (models checked, fields checked, missing: 0)", async () => {
    const ctx = await auth.$context;
    const tables = ctx.tables as unknown as TableMap;
    const r = check(tables);
    console.log(`models checked: ${r.models}, fields checked: ${r.fields}, missing: ${r.missing}`);
    expect(r.models).toBeGreaterThanOrEqual(13);
    expect(r.missing).toBe(0);
    // canary: one invented field must be reported
    const bad: TableMap = { ...tables, oauthClient: { ...tables.oauthClient!, fields: { ...tables.oauthClient!.fields, inventedField: { fieldName: "inventedField" } } } };
    expect(check(bad).missing).toBe(1);
  });
});
