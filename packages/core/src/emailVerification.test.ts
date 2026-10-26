import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, sessions, users } from "@opengmb/db";
import { createAuth } from "./auth";
import { setEmailSender, type EmailMessage } from "./email";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-123";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "correct-horse-battery-staple";

const sent: EmailMessage[] = [];
afterEach(() => {
  sent.length = 0;
  setEmailSender(null);
  vi.restoreAllMocks();
});

function setup(requireEmailVerification = true) {
  const auth = createAuth(db, { secret: SECRET, baseURL: BASE, requireEmailVerification });
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(body),
      }),
    );
  return { auth, post };
}
const linkIn = (m: EmailMessage) => m.text.match(/https?:\/\/\S*verify-email\?\S+/)![0];
const userRow = async (email: string) =>
  (await db.select().from(users).where(eq(users.email, email)))[0]!;

describe("email verification at sign-up", () => {
  it("sign-up sends a link and creates no session; sign-in is refused until the link is opened", async () => {
    setEmailSender(async (m) => void sent.push(m), true);
    const { auth, post } = setup();
    const email = `verify-${uniq()}@example.test`;

    const up = await post("/sign-up/email", {
      name: "V",
      email,
      password: PASSWORD,
      callbackURL: "/sign-in?verified=1",
    });
    expect(up.status).toBe(200);
    expect(up.headers.getSetCookie().join(";")).not.toMatch(/session_token/);
    const u = await userRow(email);
    expect(u.emailVerified).toBe(false);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toEqual([]);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.html).toContain("verify-email");

    const refused = await post("/sign-in/email", { email, password: PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie().join(";")).not.toMatch(/session_token/);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toEqual([]);

    // Opening the link verifies the address but does not sign anyone in.
    const verify = await auth.handler(new Request(linkIn(sent[0]!), { headers: { origin: BASE } }));
    expect([200, 302]).toContain(verify.status);
    expect(verify.headers.getSetCookie().join(";")).not.toMatch(/session_token/);
    expect((await userRow(email)).emailVerified).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toEqual([]);

    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
  });

  it("a correct-password sign-in by an unverified address sends a fresh link that works; a wrong password sends nothing", async () => {
    setEmailSender(async (m) => void sent.push(m), true);
    const { auth, post } = setup();
    const email = `resend-${uniq()}@example.test`;
    await post("/sign-up/email", { name: "R", email, password: PASSWORD });
    expect(sent).toHaveLength(1);
    expect((await post("/sign-in/email", { email, password: "wrong-password-1" })).status).toBe(
      401,
    );
    expect(sent).toHaveLength(1);
    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(403);
    expect(sent).toHaveLength(2);
    await auth.handler(new Request(linkIn(sent[1]!), { headers: { origin: BASE } }));
    expect((await userRow(email)).emailVerified).toBe(true);
  });

  it("AP6: the server can resend the link for an unverified address without that person's session, and not for a verified one", async () => {
    setEmailSender(async (m) => void sent.push(m), true);
    const { auth, post } = setup();
    const email = `admin-resend-${uniq()}@example.test`;
    await post("/sign-up/email", { name: "A", email, password: PASSWORD });
    expect(sent).toHaveLength(1);
    // The call the admin panel makes: no headers, so no session.
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: "/sign-in?verified=1" } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe(email);
    await auth.handler(new Request(linkIn(sent[1]!), { headers: { origin: BASE } }));
    expect((await userRow(email)).emailVerified).toBe(true);
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: "/sign-in?verified=1" } });
    expect(sent).toHaveLength(2); // already verified: nothing is sent
  });

  it("a tampered link verifies nothing", async () => {
    setEmailSender(async (m) => void sent.push(m), true);
    const { auth, post } = setup();
    const email = `tamper-${uniq()}@example.test`;
    await post("/sign-up/email", { name: "T", email, password: PASSWORD });
    const res = await auth.handler(
      new Request(linkIn(sent[0]!).replace(/token=./, "token=x"), { headers: { origin: BASE } }),
    );
    expect(res.status).not.toBe(200);
    expect((await userRow(email)).emailVerified).toBe(false);
  });

  it("with no email provider configured the link is logged so a developer can open it", async () => {
    setEmailSender(async () => {}, false); // as if Resend were not set up
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { post } = setup();
    const email = `dev-${uniq()}@example.test`;
    await post("/sign-up/email", { name: "D", email, password: PASSWORD });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(email) && l.includes("verify-email?token="))).toBe(true);
  });

  it("switched off, sign-up still signs the person in (dev, tests)", async () => {
    const { post } = setup(false);
    const email = `off-${uniq()}@example.test`;
    const up = await post("/sign-up/email", { name: "O", email, password: PASSWORD });
    expect(up.headers.getSetCookie().join(";")).toMatch(/session_token/);
  });

  it("is on by default in production only", async () => {
    const required = async (nodeEnv: string, opt?: boolean) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      try {
        const auth = createAuth(db, {
          secret: SECRET,
          baseURL: BASE,
          requireEmailVerification: opt,
        });
        return (await auth.$context).options.emailAndPassword?.requireEmailVerification;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    expect(await required("production")).toBe(true);
    expect(await required("test")).toBe(false);
    expect(await required("production", false)).toBe(false);
  });
});
