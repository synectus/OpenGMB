import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@opengmb/db";
import { createAuth } from "./auth";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-123";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** One call to Better-Auth's handler as if from `ip` (the proxy's single X-Forwarded-For entry). */
function call(auth: ReturnType<typeof createAuth>, ip: string, path: string, body: unknown) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

describe("auth rate limits", () => {
  it("sign-in: the 11th attempt in a minute from one IP is 429, another IP is unaffected", async () => {
    const auth = createAuth(db, { secret: SECRET, baseURL: BASE, rateLimitEnabled: true });
    const attempt = (ip: string) =>
      call(auth, ip, "/sign-in/email", {
        email: `nobody-${uniq()}@example.test`,
        password: "x".repeat(12),
      });
    const first = [];
    for (let i = 0; i < 10; i++) first.push((await attempt("203.0.113.10")).status);
    expect(first).not.toContain(429);
    const res = await attempt("203.0.113.10");
    expect(res.status).toBe(429);
    expect(res.headers.get("x-retry-after")).toBeTruthy();
    expect((await attempt("203.0.113.11")).status).not.toBe(429);
  });

  it("second factor: the 9th TOTP / backup-code guess in a minute from one IP is 429", async () => {
    const auth = createAuth(db, { secret: SECRET, baseURL: BASE, rateLimitEnabled: true });
    for (const path of ["/two-factor/verify-totp", "/two-factor/verify-backup-code"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) {
        statuses.push((await call(auth, "203.0.113.20", path, { code: "000000" })).status);
      }
      expect(statuses.slice(0, 8), path).not.toContain(429);
      expect(statuses[8], path).toBe(429);
    }
  });

  it("is on by default in production, off elsewhere, and can be forced either way", async () => {
    const enabled = async (nodeEnv: string, opt?: boolean) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      try {
        const auth = createAuth(db, { secret: SECRET, baseURL: BASE, rateLimitEnabled: opt });
        return (await auth.$context).rateLimit.enabled;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    expect(await enabled("production")).toBe(true);
    expect(await enabled("test")).toBe(false);
    expect(await enabled("production", false)).toBe(false);
    expect(await enabled("test", true)).toBe(true);
  });
});
