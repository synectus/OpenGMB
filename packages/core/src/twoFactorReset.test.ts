import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { generate } from "otplib";
import {
  auditLog,
  createDb,
  mcpProposals,
  memberships,
  organizations,
  sessions,
  twoFactors,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { createAuth, type Auth } from "./auth";
import { CoreError } from "./errors";
import { executeAction, executeToolCall } from "./executor";
import { actions } from "./actions";
import { AuthError, requireAuthenticatedUser } from "./session";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BASE = "http://localhost:3000";
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}
const reset = (actor: Actor, membershipId: string) =>
  executeAction(db, actor, "members.resetTwoFactor", { membershipId }) as Promise<{
    reset: true;
    sessionsEnded: number;
  }>;
const asUser = (userId: string) => loadActor(db, { userId, surface: "ui", actorType: "user" });

type Role = "owner" | "admin" | "manager" | "client_approver" | "client_viewer";

/** An org whose members have a (fixture) two-factor row and one live session each. */
async function makeOrg() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mk = async (role: Role, opts: { twoFactor?: boolean; inOrg?: string } = {}) => {
    const id = `u-${uniq()}`;
    const email = `${id}@example.test`;
    const enrolled = opts.twoFactor ?? true;
    await db
      .insert(users)
      .values({ id, name: `N ${role}`, email, emailVerified: true, twoFactorEnabled: enrolled });
    const client = role === "client_approver" || role === "client_viewer";
    const [m] = await db
      .insert(memberships)
      .values({ orgId: opts.inOrg ?? orgId, userId: id, role, workspaceId: client ? ws!.id : undefined })
      .returning();
    if (enrolled) {
      await db.insert(twoFactors).values({
        id: `tf-${uniq()}`,
        userId: id,
        secret: "fixture-secret",
        backupCodes: "fixture-codes",
        verified: true,
      });
    }
    await db.insert(sessions).values({
      id: `s-${uniq()}`,
      token: `t-${uniq()}`,
      userId: id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { id, email, membershipId: m!.id };
  };
  return { orgId, mk };
}

describe("members.resetTwoFactor: who may reset whom", () => {
  it("only an owner; never yourself; only your own org; only someone enrolled and in no other org", async () => {
    const org = await makeOrg();
    const owner = await org.mk("owner");
    const owner2 = await org.mk("owner");
    const admin = await org.mk("admin");
    const manager = await org.mk("manager");
    const approver = await org.mk("client_approver");
    const viewer = await org.mk("client_viewer");
    const notEnrolled = await org.mk("manager", { twoFactor: false });
    const other = await makeOrg();
    const stranger = await other.mk("manager");
    // An account with a membership in a second org (invitations refuse this; rows made any other way).
    const twoOrgs = await org.mk("manager");
    await db.insert(memberships).values({ orgId: other.orgId, userId: twoOrgs.id, role: "manager" });

    for (const who of [admin, manager, approver, viewer]) {
      expect(await codeOf(reset(await asUser(who.id), owner2.membershipId))).toBe("FORBIDDEN");
    }
    const o = await asUser(owner.id);
    expect(await codeOf(reset(o, owner.membershipId))).toBe("FORBIDDEN"); // yourself
    expect(await codeOf(reset(o, stranger.membershipId))).toBe("NOT_FOUND"); // other org
    expect(await codeOf(reset(o, twoOrgs.membershipId))).toBe("CONFLICT"); // cross-org account
    expect(await codeOf(reset(o, notEnrolled.membershipId))).toBe("CONFLICT"); // nothing to reset
    // Nothing above changed anything.
    expect((await db.select().from(twoFactors).where(eq(twoFactors.userId, twoOrgs.id))).length).toBe(1);

    expect(await reset(o, owner2.membershipId)).toEqual({ reset: true, sessionsEnded: 1 });
    expect(await reset(o, viewer.membershipId)).toEqual({ reset: true, sessionsEnded: 1 });
  });

  it("deletes the two-factor row and every session, clears the flag, and audits without secrets", async () => {
    const org = await makeOrg();
    const owner = await org.mk("owner");
    const target = await org.mk("manager");
    await db.insert(sessions).values({
      id: `s-${uniq()}`,
      token: `t-${uniq()}`,
      userId: target.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const out = await reset(await asUser(owner.id), target.membershipId);
    expect(out).toEqual({ reset: true, sessionsEnded: 2 });
    expect(await db.select().from(twoFactors).where(eq(twoFactors.userId, target.id))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, target.id))).toEqual([]);
    const [u] = await db.select().from(users).where(eq(users.id, target.id));
    expect(u!.twoFactorEnabled).toBe(false);
    // The owner's own session is untouched.
    expect((await db.select().from(sessions).where(eq(sessions.userId, owner.id))).length).toBe(1);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "membership.two_factor_reset")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: owner.id,
      entityType: "membership",
      entityId: target.membershipId,
      before: { userId: target.id, email: target.email, twoFactorEnabled: true, sessions: 2 },
      after: { userId: target.id, twoFactorEnabled: false, sessionsEnded: 2 },
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("fixture-secret");
    expect(json).not.toContain("fixture-codes");
  });

  it("an API token can neither run it nor propose it (no proposal row is written)", async () => {
    const org = await makeOrg();
    const owner = await org.mk("owner");
    const target = await org.mk("manager");
    const token: Actor = {
      ...(await asUser(owner.id)),
      surface: "mcp",
      actorType: "api_token",
      apiTokenId: crypto.randomUUID(),
      scopes: ["read", "write"],
    };
    expect(await codeOf(reset(token, target.membershipId))).toBe("FORBIDDEN");
    expect(
      await codeOf(
        executeToolCall(db, token, "members.resetTwoFactor", { membershipId: target.membershipId }),
      ),
    ).toBe("FORBIDDEN");
    const proposals = await db
      .select()
      .from(mcpProposals)
      .where(and(eq(mcpProposals.userId, owner.id), eq(mcpProposals.action, "members.resetTwoFactor")));
    expect(proposals).toEqual([]);
    expect((await db.select().from(twoFactors).where(eq(twoFactors.userId, target.id))).length).toBe(1);
  });

  it("members.list says who has two-factor on", async () => {
    const org = await makeOrg();
    const owner = await org.mk("owner");
    const off = await org.mk("manager", { twoFactor: false });
    const out = (await executeAction(db, await asUser(owner.id), "members.list", {})) as {
      members: { userId: string; twoFactorEnabled: boolean }[];
    };
    const by = new Map(out.members.map((m) => [m.userId, m.twoFactorEnabled]));
    expect(by.get(owner.id)).toBe(true);
    expect(by.get(off.id)).toBe(false);
  });

  it("is registered with the owner-only permission, as a two_phase write", () => {
    const a = actions.find((x) => x.name === "members.resetTwoFactor");
    expect(a?.permission).toBe("member:reset_two_factor");
    expect(a?.kind).toBe("write");
    expect(a?.approval ?? "two_phase").toBe("two_phase");
  });
});

/** Minimal cookie jar over the real Better-Auth instance (same shape as auth.test.ts). */
class Client {
  constructor(private readonly a: Auth = auth) {}
  private jar = new Map<string, string>();
  async post(path: string, body: unknown) {
    const res = await this.a.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: this.cookie() },
        body: JSON.stringify(body),
      }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return {
      res,
      json: (await res.json().catch(() => null)) as {
        totpURI?: string;
        backupCodes?: string[];
        twoFactorRedirect?: boolean;
      } | null,
    };
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  session() {
    return this.a.api.getSession({ headers: new Headers({ cookie: this.cookie() }) });
  }
}
const totp = (uri: string) =>
  generate({ secret: new URL(uri).searchParams.get("secret")!, strategy: "totp" });
function gate(s: Awaited<ReturnType<Client["session"]>>): string {
  try {
    requireAuthenticatedUser(s);
    return "ok";
  } catch (e) {
    return e instanceof AuthError ? e.code : `other:${String(e)}`;
  }
}

describe("members.resetTwoFactor: the real Better-Auth path", () => {
  it("old sessions die; the next sign-in has no challenge but the gate demands setup; enrolling again works", async () => {
    // A real user U with TOTP, signed in on two devices. Signing up gives U a personal org as owner;
    // a second owner O of that org does the reset.
    const email = `reset-${uniq()}@example.test`;
    const password = "correct-horse-battery-staple";
    const a = new Client();
    await a.post("/sign-up/email", { name: "U", email, password });
    const enable = await a.post("/two-factor/enable", { password });
    const uri = enable.json!.totpURI!;
    const oldCodes = enable.json!.backupCodes!;
    await a.post("/two-factor/verify-totp", { code: await totp(uri) });
    expect(gate(await a.session())).toBe("ok");
    const b = new Client();
    expect((await b.post("/sign-in/email", { email, password })).json!.twoFactorRedirect).toBe(true);
    await b.post("/two-factor/verify-totp", { code: await totp(uri) });
    expect(gate(await b.session())).toBe("ok");

    const userId = (await a.session())!.user.id;
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, userId));
    const oId = `u-${uniq()}`;
    await db.insert(users).values({ id: oId, name: "O", email: `${oId}@example.test`, emailVerified: true });
    await db.insert(memberships).values({ orgId: m!.orgId, userId: oId, role: "owner" });

    const out = await reset(await asUser(oId), m!.id);
    expect(out.sessionsEnded).toBeGreaterThanOrEqual(2);
    expect(await a.session()).toBeNull();
    expect(await b.session()).toBeNull();

    // Next sign-in: no TOTP challenge (the flag is off), and the gate sends U to setup.
    const c = new Client();
    const again = await c.post("/sign-in/email", { email, password });
    expect(again.res.status).toBe(200);
    expect(again.json?.twoFactorRedirect).toBeUndefined();
    expect(gate(await c.session())).toBe("MFA_REQUIRED");

    // The old authenticator and backup codes are gone; a fresh enrolment works.
    const fresh = await c.post("/two-factor/enable", { password });
    expect(fresh.res.status).toBe(200);
    expect(fresh.json!.totpURI).not.toBe(uri);
    expect(fresh.json!.backupCodes).not.toEqual(oldCodes);
    await c.post("/two-factor/verify-totp", { code: await totp(fresh.json!.totpURI!) });
    expect(gate(await c.session())).toBe("ok");

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, m!.orgId), eq(auditLog.action, "membership.two_factor_reset")));
    const json = JSON.stringify(audit);
    expect(json).not.toContain(new URL(uri).searchParams.get("secret")!);
    for (const code of oldCodes) expect(json).not.toContain(code);
  });
});
