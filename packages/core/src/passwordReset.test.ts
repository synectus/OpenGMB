import { afterAll, afterEach, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { and, eq } from "drizzle-orm";
import { auditLog, createDb, memberships, sessions, users, verifications } from "@opengmb/db";
import { createAuth } from "./auth";
import { setEmailSender, type EmailMessage } from "./email";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-123";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OLD = "correct-horse-battery-staple";
const NEW = "a-different-long-passphrase-9";

const sent: EmailMessage[] = [];
afterEach(() => {
  sent.length = 0;
  setEmailSender(null);
});

const auth = createAuth(db, { secret: SECRET, baseURL: BASE });

async function post(path: string, body: unknown, cookie = "") {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
const cookieOf = (res: Response) =>
  res.headers.getSetCookie().map((l) => l.split(";")[0]).join("; ");
const tokenIn = (m: EmailMessage) => new URL(m.text.match(/https?:\/\/\S*reset-password\?\S+/)![0]).searchParams.get("token")!;
/** The send is deliberately not awaited by the request, so wait for the fake sender to see it. */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function signUp(email: string) {
  const r = await post("/sign-up/email", { name: "Reset Tester", email, password: OLD });
  expect(r.res.status).toBe(200);
  return { cookie: cookieOf(r.res), id: (await db.select().from(users).where(eq(users.email, email)))[0]!.id };
}
async function request(email: string) {
  setEmailSender(async (m) => void sent.push(m), true);
  const r = await post("/request-password-reset", { email });
  await settle();
  return r;
}

describe("password reset by email", () => {
  it("an existing user gets exactly one email with a /reset-password?token= link; an unknown address gets nothing and the same answer", async () => {
    const email = `pwr-${uniq()}@example.test`;
    await signUp(email);
    const known = await request(email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    // The From display name is configuration (EMAIL_FROM), not code; the subject and body are ours.
    expect(sent[0]!.subject).toBe("Reset your OpenGMB password");
    expect(sent[0]!.html).toContain("OpenGMB");
    expect(sent[0]!.html).toContain("reset-password?token=");
    expect(tokenIn(sent[0]!).length).toBeGreaterThan(10);

    sent.length = 0;
    const unknown = await request(`nobody-${uniq()}@example.test`);
    expect(sent).toHaveLength(0);
    expect(unknown.res.status).toBe(known.res.status);
    expect(unknown.json).toEqual(known.json);
  });

  it("a valid token changes the password and revokes every session; the token cannot be used twice", async () => {
    const email = `pwr-${uniq()}@example.test`;
    const { id } = await signUp(email);
    expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(1);
    await request(email);
    const token = tokenIn(sent[0]!);

    const weak = await post("/reset-password", { token, newPassword: "short" });
    expect(weak.res.status).toBe(400);

    const ok = await post("/reset-password", { token, newPassword: NEW });
    expect(ok.res.status).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);
    expect((await post("/sign-in/email", { email, password: OLD })).res.status).toBe(401);
    expect((await post("/sign-in/email", { email, password: NEW })).res.status).toBe(200);

    const again = await post("/reset-password", { token, newPassword: "yet-another-passphrase-3" });
    expect(again.res.status).toBe(400);
    expect(again.json?.code).toBe("INVALID_TOKEN");
  });

  it("an expired token is refused with INVALID_TOKEN and the password stays", async () => {
    const email = `pwr-${uniq()}@example.test`;
    await signUp(email);
    await request(email);
    const token = tokenIn(sent[0]!);
    await db
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verifications.identifier, `reset-password:${token}`));
    const r = await post("/reset-password", { token, newPassword: NEW });
    expect(r.res.status).toBe(400);
    expect(r.json?.code).toBe("INVALID_TOKEN");
    expect((await post("/sign-in/email", { email, password: OLD })).res.status).toBe(200);
  });

  it("the token lasts 30 minutes", async () => {
    const email = `pwr-${uniq()}@example.test`;
    await signUp(email);
    const before = Date.now();
    await request(email);
    const [row] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, `reset-password:${tokenIn(sent[0]!)}`));
    const minutes = (row!.expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30.1);
  });

  it("two-factor is still required at the next sign-in", async () => {
    const email = `pwr-${uniq()}@example.test`;
    const { cookie } = await signUp(email);
    const enable = await post("/two-factor/enable", { password: OLD }, cookie);
    const uri = enable.json!.totpURI as string;
    const secret = new URL(uri).searchParams.get("secret")!;
    expect((await post("/two-factor/verify-totp", { code: await generate({ secret, strategy: "totp" }) }, cookie)).res.status).toBe(200);

    await request(email);
    expect((await post("/reset-password", { token: tokenIn(sent[0]!), newPassword: NEW })).res.status).toBe(200);
    const signIn = await post("/sign-in/email", { email, password: NEW });
    expect(signIn.json?.twoFactorRedirect).toBe(true);
    expect(signIn.res.headers.getSetCookie().join(";")).not.toMatch(/session_token=[^;]/);
  });

  it("audits requested and completed with the user id only, no address and no token", async () => {
    const email = `pwr-${uniq()}@example.test`;
    const { id } = await signUp(email);
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, id));
    await request(email);
    const token = tokenIn(sent[0]!);
    await post("/reset-password", { token, newPassword: NEW });
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.orgId, m!.orgId), eq(auditLog.entityId, id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.password_reset_requested");
    expect(actions).toContain("auth.password_reset_completed");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain(token);
  });

  it("the sixth request for one address in an hour is 429 (whether or not it has an account); other addresses are unaffected", async () => {
    setEmailSender(async (m) => void sent.push(m), true);
    const email = `pwr-limit-${uniq()}@example.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("/request-password-reset", { email })).res.status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect((await post("/request-password-reset", { email: `pwr-other-${uniq()}@example.test` })).res.status).toBe(200);
  });

  it("per IP: the 11th request in an hour from one address is 429 when the limiter is on", async () => {
    const limited = createAuth(db, { secret: SECRET, baseURL: BASE, rateLimitEnabled: true });
    const call = (ip: string) =>
      limited.handler(
        new Request(`${BASE}/api/auth/request-password-reset`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": ip },
          body: JSON.stringify({ email: `ip-${uniq()}@example.test` }),
        }),
      );
    const first: number[] = [];
    for (let i = 0; i < 10; i++) first.push((await call("203.0.113.77")).status);
    expect(first).not.toContain(429);
    expect((await call("203.0.113.77")).status).toBe(429);
    expect((await call("203.0.113.78")).status).not.toBe(429);
  });
});
