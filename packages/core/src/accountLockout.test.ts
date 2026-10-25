import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@opengmb/db";
import { createAuth } from "./auth";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-123";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "correct-horse-battery-staple";

function setup(failures = 3) {
  let t = 1_000_000;
  const auth = createAuth(db, {
    secret: SECRET,
    baseURL: BASE,
    lockout: { failures, windowMinutes: 15, now: () => t },
  });
  const post = (path: string, body: unknown, ip = "198.51.100.1") =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );
  const signIn = (email: string, password: string, ip?: string) =>
    post("/sign-in/email", { email, password }, ip);
  return { auth, post, signIn, advance: (ms: number) => void (t += ms) };
}

describe("per-account sign-in lockout", () => {
  it("locks the address after N wrong passwords, even for the right password and another IP, then unlocks by time", async () => {
    const { post, signIn, advance } = setup(3);
    const email = `lock-${uniq()}@example.test`;
    expect((await post("/sign-up/email", { name: "L", email, password: PASSWORD })).status).toBe(
      200,
    );

    for (let i = 0; i < 3; i++) {
      expect((await signIn(email, "wrong-password-1", `203.0.113.${i + 1}`)).status).toBe(401);
    }
    // Locked: the right password is refused too, from a different IP, with a retry hint.
    const locked = await signIn(email, PASSWORD, "203.0.113.99");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await locked.json()) as { message: string }).message).toMatch(/too many/i);
    // The email is matched case-insensitively.
    expect((await signIn(email.toUpperCase(), PASSWORD)).status).toBe(429);

    // Still locked just before the window ends, open right after: time-based, not permanent.
    advance(15 * 60_000 - 1_000);
    expect((await signIn(email, PASSWORD)).status).toBe(429);
    advance(2_000);
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  });

  it("one account's lockout does not touch another account", async () => {
    const { post, signIn } = setup(2);
    const a = `a-${uniq()}@example.test`;
    const b = `b-${uniq()}@example.test`;
    for (const email of [a, b])
      await post("/sign-up/email", { name: "X", email, password: PASSWORD });
    for (let i = 0; i < 2; i++) await signIn(a, "nope-nope-nope");
    expect((await signIn(a, PASSWORD)).status).toBe(429);
    expect((await signIn(b, PASSWORD)).status).toBe(200);
  });

  it("a successful sign-in clears earlier failures", async () => {
    const { post, signIn } = setup(3);
    const email = `reset-${uniq()}@example.test`;
    await post("/sign-up/email", { name: "R", email, password: PASSWORD });
    for (let round = 0; round < 3; round++) {
      await signIn(email, "bad-password-1");
      await signIn(email, "bad-password-2");
      expect((await signIn(email, PASSWORD)).status, `round ${round}`).toBe(200);
    }
  });

  it("an address that does not exist locks the same way (nothing reveals which accounts exist)", async () => {
    const { signIn } = setup(2);
    const email = `ghost-${uniq()}@example.test`;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await signIn(email, "whatever-password")).status);
    expect(statuses).toEqual([401, 401, 429, 429]);
  });
});
