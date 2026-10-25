import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "@opengmb/core";
import { createDb, memberships, organizations, users } from "@opengmb/db";
import { WindowLimiter, clientIp } from "./rateLimit";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("WindowLimiter", () => {
  it("counts per key, resets after the window, and reports the wait", () => {
    let t = 1_000;
    const l = new WindowLimiter(2, 60_000, () => t);
    expect(l.hit("a")).toBe(0);
    expect(l.hit("a")).toBe(0);
    expect(l.blockedFor("a")).toBeGreaterThan(0);
    expect(l.hit("a")).toBe(60);
    expect(l.blockedFor("b")).toBe(0);
    t += 59_000;
    expect(l.blockedFor("a")).toBe(1);
    t += 1_000;
    expect(l.blockedFor("a")).toBe(0);
    expect(l.hit("a")).toBe(0);
  });
});

describe("clientIp", () => {
  const req = (xff: string | undefined, remote = "10.0.0.9") =>
    ({
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
      socket: { remoteAddress: remote },
    }) as unknown as IncomingMessage;
  it("takes the entry the nearest proxy appended, never a client-supplied one", () => {
    expect(clientIp(req("198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(clientIp(req("1.1.1.1, 198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(clientIp(req("1.1.1.1, 198.51.100.7, 172.16.0.2"), 2)).toBe("198.51.100.7");
  });
  it("falls back to the socket with no header or no proxy", () => {
    expect(clientIp(req(undefined), 1)).toBe("10.0.0.9");
    expect(clientIp(req("198.51.100.7"), 0)).toBe("10.0.0.9");
  });
});

describe("MCP endpoint rate limits", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let email: string;
  beforeAll(async () => {
    server = await startServer(0, {
      db,
      rateLimits: { authFailuresPerMinute: 3, requestsPerMinute: 5, proxyHops: 1 },
    });
    const [org] = await db
      .insert(organizations)
      .values({ name: `rl-${uniq()}` })
      .returning();
    const id = `u-${uniq()}`;
    email = `${id}@example.test`;
    await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role: "owner" });
  });
  afterAll(async () => {
    await server.close();
    await sql.end();
  });

  const post = (token: string | undefined, ip: string, extraXff = "") =>
    fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-for": extraXff ? `${extraXff}, ${ip}` : ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("an address with 3 bad tokens is refused with 429 before any lookup, even with a good token", async () => {
    const good = (await createApiToken(db, { email })).token;
    const ip = "198.51.100.1";
    for (let i = 0; i < 3; i++) expect((await post("sgmb_wrong", ip)).status).toBe(401);
    const blocked = await post("sgmb_wrong", ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(good, ip)).status).toBe(429);
    // Another address is untouched, and rotating the client-supplied part of X-Forwarded-For does not help.
    expect((await post(good, "198.51.100.2")).status).toBe(200);
    expect((await post("sgmb_wrong", ip, "9.9.9.9")).status).toBe(429);
  });

  it("a missing token counts as a failure too", async () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < 3; i++) expect((await post(undefined, ip)).status).toBe(401);
    expect((await post(undefined, ip)).status).toBe(429);
  });

  it("one token gets 5 requests a minute here, then 429, and another token is unaffected", async () => {
    const a = (await createApiToken(db, { email })).token;
    const b = (await createApiToken(db, { email })).token;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(a, "198.51.100.4")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await post(b, "198.51.100.4")).status).toBe(200);
  });
});
