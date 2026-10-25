import { afterAll, afterEach, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { eq } from "drizzle-orm";
import { createDb, memberships, orgBranding, users, workspaces } from "@opengmb/db";
import { createAuth } from "./auth";
import { setEmailSender, type EmailMessage } from "./email";
import { MAGIC_LINK_REQUESTS_PER_EMAIL_PER_HOUR } from "./magic-link";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE });

const sent: EmailMessage[] = [];
afterEach(() => {
  sent.length = 0;
  setEmailSender(null);
});

class Client {
  private jar = new Map<string, string>();
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), value);
    }
  }
  async post(path: string, body: unknown) {
    const res = await auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: this.cookie() },
        body: JSON.stringify(body),
      }),
    );
    this.absorb(res);
    return { res, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  }
  async get(link: string) {
    const res = await auth.handler(new Request(link, { headers: { cookie: this.cookie() } }));
    this.absorb(res);
    return res;
  }
  session() {
    return auth.api.getSession({ headers: new Headers({ cookie: this.cookie() }) });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const linkIn = (m: EmailMessage) => m.text.match(/https?:\/\/\S*magic-link\/verify\?\S+/)![0];

/** Signs up (an owner of a new organization); `asClient` turns the membership into a client approver. */
async function makeUser(opts: { asClient: boolean; agency?: string }) {
  const email = `ml-${uniq()}@example.test`;
  const c = new Client();
  const up = await c.post("/sign-up/email", { name: "Link Tester", email, password: PASSWORD });
  expect(up.res.status).toBe(200);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (opts.asClient) {
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, u!.id));
    const [ws] = await db.insert(workspaces).values({ orgId: m!.orgId, name: "Client Co" }).returning();
    await db
      .update(memberships)
      .set({ role: "client_approver", workspaceId: ws!.id })
      .where(eq(memberships.id, m!.id));
    if (opts.agency) await db.insert(orgBranding).values({ orgId: m!.orgId, agencyName: opts.agency });
  }
  return { email, id: u!.id, c };
}

async function request(email: string) {
  setEmailSender(async (m) => void sent.push(m), true);
  const r = await new Client().post("/sign-in/magic-link", { email, callbackURL: "/" });
  await settle();
  return r;
}

describe("magic-link sign-in for client users", () => {
  it("a client approver gets one email with the agency name; the link signs them in once", async () => {
    const { email } = await makeUser({ asClient: true, agency: "Acme Marketing" });
    const r = await request(email);
    expect(r.res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject).toContain("Acme Marketing");
    expect(sent[0]!.html).toContain("Acme Marketing");

    const c = new Client();
    const ok = await c.get(linkIn(sent[0]!));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`${BASE}/`);
    expect((await c.session())?.user.email).toBe(email);

    // one use only
    const again = new Client();
    const second = await again.get(linkIn(sent[0]!));
    expect(second.headers.get("location")).toContain("error=INVALID_TOKEN");
    expect(await again.session()).toBeNull();
  });

  it("staff and unknown addresses get no email and the same answer as a client", async () => {
    const client = await makeUser({ asClient: true });
    const staff = await makeUser({ asClient: false });
    const known = await request(client.email);
    sent.length = 0;
    const s = await request(staff.email);
    const unknown = await request(`nobody-${uniq()}@example.test`);
    expect(sent).toHaveLength(0);
    expect(s.res.status).toBe(known.res.status);
    expect(unknown.json).toEqual(known.json);
  });

  it("never creates an account for an unknown address", async () => {
    const email = `nobody-${uniq()}@example.test`;
    await request(email);
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("a user with two-factor still gets the TOTP challenge, not a session", async () => {
    const { email, c } = await makeUser({ asClient: true });
    const enable = await c.post("/two-factor/enable", { password: PASSWORD });
    const secret = new URL(enable.json!.totpURI as string).searchParams.get("secret")!;
    expect((await c.post("/two-factor/verify-totp", { code: await generate({ secret }) })).res.status).toBe(200);
    await c.post("/sign-out", {});

    await request(email);
    const fresh = new Client();
    const res = await fresh.get(linkIn(sent[0]!));
    expect(res.headers.get("location")).toBe("/mfa/verify");
    expect(await fresh.session()).toBeNull();
    const done = await fresh.post("/two-factor/verify-totp", { code: await generate({ secret }) });
    expect(done.res.status).toBe(200);
    expect((await fresh.session())?.user.email).toBe(email);
  });

  it("limits requests per address and still answers 200 for the first ones", async () => {
    const { email } = await makeUser({ asClient: true });
    for (let i = 0; i < MAGIC_LINK_REQUESTS_PER_EMAIL_PER_HOUR; i++) {
      expect((await request(email)).res.status).toBe(200);
    }
    expect((await request(email)).res.status).toBe(429);
  });
});
