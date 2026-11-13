import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@opengmb/db";
import { createAuth } from "../auth";
import { normaliseRegistration, RegistrationError } from "./registration";
import { ANTHROPIC_EGRESS, TRUSTED_REGISTER_RATE_LIMIT, ipInCidrs, registerRateRule } from "./trusted-registration";
import { REGISTER_RATE_LIMIT } from "./provider";

const base = { client_name: "X", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };

describe("normaliseRegistration", () => {
  it("canary: an https redirect passes unchanged", () => {
    const body = { ...base, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
    expect(normaliseRegistration(body)).toEqual(body);
  });
  it("loopback http without application_type becomes native (Claude Code, Cursor, MCP Inspector)", () => {
    for (const uri of ["http://localhost:6274/oauth/callback", "http://127.0.0.1:53682/callback", "http://[::1]:9000/cb"]) {
      expect(normaliseRegistration({ ...base, redirect_uris: [uri] }).application_type).toBe("native");
    }
  });
  it("keeps an explicit application_type", () => {
    expect(normaliseRegistration({ ...base, application_type: "web", redirect_uris: ["http://localhost:1/cb"] }).application_type).toBe("web");
  });
  it("mixed https and loopback is left to the plugin (no application_type added)", () => {
    expect(normaliseRegistration({ ...base, redirect_uris: ["https://a.example.test/cb", "http://localhost:1/cb"] }).application_type).toBeUndefined();
  });
  it("refuses http on a non-loopback host", () => {
    expect(() => normaliseRegistration({ ...base, redirect_uris: ["http://evil.example.test/cb"] })).toThrow(RegistrationError);
  });
  it("refuses private-use and other schemes", () => {
    for (const uri of ["com.example.app:/cb", "cursor://anysphere.cursor-retrieval/oauth", "javascript:alert(1)", "not a url"]) {
      expect(() => normaliseRegistration({ ...base, redirect_uris: [uri] }), uri).toThrow(RegistrationError);
    }
  });
  it("leaves a body without redirect_uris to the plugin's own validation", () => {
    expect(normaliseRegistration({ ...base })).toEqual({ ...base });
  });
});

describe("open registration rate limit (real auth instance, limiter on)", () => {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set");
  const { db, sql: client } = createDb(url);
  afterAll(() => client.end());
  const BASE = "http://localhost:3000";
  const auth = createAuth(db, {
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: BASE,
    rateLimitEnabled: true,
    oauthEnv: { BETTER_AUTH_URL: BASE },
  });
  const register = (ip: string) =>
    auth.handler(
      new Request(`${BASE}/api/auth/oauth2/register`, {
        method: "POST",
        // No Origin and no cookie: how a connector client registers.
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ ...base, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
      }),
    );

  it("10 registrations an hour from one address, the 11th is 429; another address is unaffected", async () => {
    const ip = `198.51.100.${100 + Math.floor(Math.random() * 100)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await register(ip)).status);
    const other = await register("198.51.100.250");
    console.log(`registrations: ${statuses.length} from one IP (${statuses.filter((x) => x === 201).length} created, ${statuses.filter((x) => x === 429).length} limited), 1 from another (${other.status})`);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
    expect(other.status).toBe(201);
  });
});

describe("trusted registration range (Anthropic egress, DCR on every fresh connection)", () => {
  const current = { window: REGISTER_RATE_LIMIT.window, max: REGISTER_RATE_LIMIT.max };
  const req = (xff?: string) => new Request("http://localhost:3000/api/auth/oauth2/register", { method: "POST", headers: xff ? { "x-forwarded-for": xff } : {} });

  it("config carries its source and verified-on date", () => {
    expect(ANTHROPIC_EGRESS.cidrs.length).toBeGreaterThan(0); // fail on zero
    expect(ANTHROPIC_EGRESS.source).toMatch(/^https:\/\/claude\.com\/docs\/connectors\/building\/authentication$/);
    expect(ANTHROPIC_EGRESS.verifiedOn).toBe("2026-11-12");
    expect(TRUSTED_REGISTER_RATE_LIMIT.max).toBeGreaterThan(REGISTER_RATE_LIMIT.max);
  });
  it("ipInCidrs: edges of 160.79.104.0/21 and bad input", () => {
    const c = ANTHROPIC_EGRESS.cidrs;
    for (const ip of ["160.79.104.0", "160.79.104.5", "160.79.111.255", "::ffff:160.79.108.1"]) expect(ipInCidrs(ip, c), ip).toBe(true);
    for (const ip of ["160.79.103.255", "160.79.112.0", "198.51.100.7", "", "unknown", "160.79.104", "2001:db8::1", "160.79.104.256"]) expect(ipInCidrs(ip, c), ip).toBe(false);
  });
  it("only the address the nearest proxy saw counts: a spoofed left entry is ignored", () => {
    const real = "198.51.100.7";
    const trusted = "160.79.104.9";
    expect(registerRateRule(req(`${real}, ${trusted}`), current, 1)).toEqual(TRUSTED_REGISTER_RATE_LIMIT); // proxy saw Anthropic
    expect(registerRateRule(req(`${trusted}, ${real}`), current, 1)).toEqual(current); // client claimed it, proxy saw someone else
    expect(registerRateRule(req(), current, 1)).toEqual(current); // no header: no proxy, nothing to trust
    expect(registerRateRule(req(trusted), current, 0)).toEqual(current); // no proxy configured: header not trusted
  });
});

describe("registration limit for the Anthropic range (real auth instance, limiter on)", () => {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set");
  const { db, sql: client } = createDb(url);
  afterAll(() => client.end());
  const BASE = "http://localhost:3000";
  const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE, rateLimitEnabled: true, oauthEnv: { BETTER_AUTH_URL: BASE } });
  const register = (xff: string) =>
    auth.handler(
      new Request(`${BASE}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff },
        body: JSON.stringify({ ...base, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
      }),
    );
  const rand = () => 20 + Math.floor(Math.random() * 200);

  it("an address in 160.79.104.0/21 registers past the normal 10 an hour; outside it, and a spoofed header, are still limited", async () => {
    const inRange = `160.79.104.${rand()}`;
    const trusted: number[] = [];
    for (let i = 0; i < 15; i++) trusted.push((await register(inRange)).status);
    const outside = `198.51.100.${rand()}`;
    const limited: number[] = [];
    for (let i = 0; i < 11; i++) limited.push((await register(outside)).status);
    // Left entry claims Anthropic, the proxy appended the real address: no exemption.
    const spoofReal = `198.51.100.${rand()}`;
    const claim = `160.79.104.${rand()}`; // fixed, so whichever entry Better-Auth buckets on, every call shares one bucket
    const spoofed: number[] = [];
    for (let i = 0; i < 11; i++) spoofed.push((await register(`${claim}, ${spoofReal}`)).status);
    console.log(`trusted: ${trusted.filter((x) => x === 201).length}/15 created; outside: ${limited.filter((x) => x === 201).length} created, ${limited.filter((x) => x === 429).length} limited; spoofed: ${spoofed.filter((x) => x === 429).length} limited of 11`);
    expect(trusted).toEqual(Array(15).fill(201));
    expect(limited.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(limited[10]).toBe(429);
    expect(spoofed[10]).toBe(429);
  });
});
