import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  createDb,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import type { Db } from "@opengmb/db";
import type { Actor } from "./actor";
import {
  createApiToken,
  findActiveTokensByName,
  hashApiToken,
  resolveRevokeTarget,
  revokeApiTokenAsCli,
  type ActiveTokenMatch,
} from "./apiTokens";
import { verifyAuditChain } from "./audit";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import type { Role } from "./permissions";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeOrg(d: Db) {
  const [o] = await d
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  return o!.id;
}
/** An org-wide member (workspace-less roles only; client roles need a workspace). */
async function makeMember(d: Db, orgId: string, role: Role) {
  const id = `u-${uniq()}`;
  const email = `${id}@example.test`;
  await d.insert(users).values({ id, name: "T", email });
  if (role === "client_approver" || role === "client_viewer") {
    const [w] = await d
      .insert(workspaces)
      .values({ orgId, name: `ws-${uniq()}` })
      .returning();
    await d.insert(memberships).values({ orgId, userId: id, role, workspaceId: w!.id });
  } else {
    await d.insert(memberships).values({ orgId, userId: id, role });
  }
  const actor: Actor = {
    userId: id,
    orgId,
    role,
    workspaceIds: "all",
    surface: "ui",
    actorType: "user",
  };
  return { id, email, actor };
}
const asToken = (a: Actor): Actor => ({
  ...a,
  surface: "mcp",
  actorType: "api_token",
  apiTokenId: crypto.randomUUID(),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
}

type Created = { token: string; apiToken: { id: string; ownerEmail: string } };
const create = (a: Actor, name = "t") =>
  executeAction(db, a, "apiTokens.create", { name }) as Promise<Created>;
const revoke = (a: Actor, id: string) => executeAction(db, a, "apiTokens.revoke", { id });
const list = async (a: Actor) =>
  (
    (await executeAction(db, a, "apiTokens.list", {})) as {
      tokens: { id: string; ownerEmail: string }[];
    }
  ).tokens;

const ROLES: Role[] = ["owner", "admin", "manager", "client_approver", "client_viewer"];
const CAN_ADMIN = new Set<Role>(["owner", "admin"]);

describe.each(ROLES)("api token policy: %s", (role) => {
  it("lists, creates and revokes its own token", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, role);
    const made = await create(me.actor, "mine");
    expect(made.token.startsWith("sgmb_")).toBe(true);
    expect((await list(me.actor)).map((t) => t.id)).toContain(made.apiToken.id);
    await revoke(me.actor, made.apiToken.id);
  });

  it(`${CAN_ADMIN.has(role) ? "may" : "may not"} see and revoke another user's token`, async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, role);
    const other = await makeMember(db, org, "manager");
    const theirs = await create(other.actor, "theirs");
    const seen = await list(me.actor);
    if (CAN_ADMIN.has(role)) {
      expect(seen.find((t) => t.id === theirs.apiToken.id)?.ownerEmail).toBe(other.email);
      await revoke(me.actor, theirs.apiToken.id);
    } else {
      expect(seen.map((t) => t.id)).not.toContain(theirs.apiToken.id);
      expect(await codeOf(revoke(me.actor, theirs.apiToken.id))).toBe("FORBIDDEN");
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, theirs.apiToken.id));
      expect(row!.revokedAt).toBeNull();
    }
  });

  it("an MCP-authenticated caller cannot create a token but can revoke one", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, role);
    const before = await db.select().from(apiTokens).where(eq(apiTokens.orgId, org));
    expect(await codeOf(create(asToken(me.actor)))).toBe("FORBIDDEN");
    expect(await db.select().from(apiTokens).where(eq(apiTokens.orgId, org))).toHaveLength(
      before.length,
    );
    const made = await create(me.actor, "to-revoke");
    await revoke(asToken(me.actor), made.apiToken.id);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, made.apiToken.id));
    expect(row!.revokedAt).not.toBeNull();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org), eq(auditLog.action, "api_token.revoke")));
    expect(audit[0]).toMatchObject({ surface: "mcp", actorType: "api_token" });
  });
});

describe.each(ROLES)("apiTokens.current: %s", (role) => {
  it("describes a token caller, and a web session has token null", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, role);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, org));
    type Current = {
      organization: { id: string; name: string };
      user: { email: string };
      role: string;
      token: { id: string; name: string; scopes: string[] } | null;
    };
    const web = (await executeAction(db, me.actor, "apiTokens.current", {})) as Current;
    expect(web).toMatchObject({
      organization: { id: org, name: o!.name },
      user: { email: me.email },
      role,
      token: null,
    });
    const made = await create(me.actor, "current-t");
    const tokenActor: Actor = {
      ...me.actor,
      surface: "mcp",
      actorType: "api_token",
      apiTokenId: made.apiToken.id,
      scopes: ["read"],
    };
    const viaToken = (await executeAction(db, tokenActor, "apiTokens.current", {})) as Current;
    expect(viaToken.token).toEqual({
      id: made.apiToken.id,
      name: "current-t",
      scopes: ["read"],
      mode: "human_in_the_loop",
    });
    expect(JSON.stringify(viaToken)).not.toMatch(/token_?hash/i);
  });
});

describe("api token edge cases", () => {
  it("the FORBIDDEN message for MCP create is clear", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, "owner");
    await expect(create(asToken(me.actor))).rejects.toThrow(/API tokens cannot create API tokens/);
  });

  it("admin cannot create a token for another user (input has no user field)", async () => {
    const org = await makeOrg(db);
    const admin = await makeMember(db, org, "admin");
    const other = await makeMember(db, org, "manager");
    const made = (await executeAction(db, admin.actor, "apiTokens.create", {
      name: "x",
      userId: other.id,
    })) as Created;
    expect(made.apiToken.ownerEmail).toBe(admin.email);
  });

  it("revoking twice is CONFLICT", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, "manager");
    const made = await create(me.actor);
    await revoke(me.actor, made.apiToken.id);
    expect(await codeOf(revoke(me.actor, made.apiToken.id))).toBe("CONFLICT");
  });

  it("a token from another org is NOT_FOUND, even for an owner", async () => {
    const a = await makeMember(db, await makeOrg(db), "owner");
    const b = await makeMember(db, await makeOrg(db), "owner");
    const theirs = await create(b.actor);
    expect(await codeOf(revoke(a.actor, theirs.apiToken.id))).toBe("NOT_FOUND");
    expect(await codeOf(revoke(a.actor, crypto.randomUUID()))).toBe("NOT_FOUND");
    expect((await list(a.actor)).map((t) => t.id)).not.toContain(theirs.apiToken.id);
  });

  it("the token hash never appears in action output or audit rows", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, "owner");
    const made = await create(me.actor, "secret-check");
    const [stored] = await db.select().from(apiTokens).where(eq(apiTokens.id, made.apiToken.id));
    const hash = stored!.tokenHash;
    expect(hash).toBe(hashApiToken(made.token));
    const revoked = await revoke(me.actor, made.apiToken.id);
    const listed = await list(me.actor);
    // The plaintext appears only in the create result, and the hash nowhere.
    expect(JSON.stringify(made)).not.toContain(hash);
    expect(JSON.stringify(revoked)).not.toContain(hash);
    expect(JSON.stringify(listed)).not.toContain(hash);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, org));
    const tokenAudits = audits.filter((r) => r.entityType === "api_token");
    expect(tokenAudits.map((r) => r.action).sort()).toEqual([
      "api_token.create",
      "api_token.revoke",
    ]);
    for (const r of audits) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(hash);
      expect(text).not.toContain(made.token);
      expect(text).not.toMatch(/token_?hash/i);
    }
    expect((await verifyAuditChain(db, org)).ok).toBe(true);
  });

  it("CLI create and revoke use surface 'cli', actor_type 'user', and the same rules", async () => {
    const org = await makeOrg(db);
    const me = await makeMember(db, org, "manager");
    const { token, row } = await createApiToken(db, { email: me.email, name: "cli-t" });
    expect(token.startsWith("sgmb_")).toBe(true);
    expect(row).not.toHaveProperty("tokenHash");
    const found = await findActiveTokensByName(db, "cli-t");
    const match = found.find((m) => m.id === row.id)!;
    expect(match).toMatchObject({ ownerEmail: me.email, orgId: org });
    await revokeApiTokenAsCli(db, match);
    expect(await codeOf(revokeApiTokenAsCli(db, match))).toBe("CONFLICT");
    expect((await findActiveTokensByName(db, "cli-t")).map((m) => m.id)).not.toContain(row.id);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org), eq(auditLog.entityType, "api_token")))
      .orderBy(auditLog.id);
    expect(audits.map((a) => [a.action, a.surface, a.actorType, a.actorUserId])).toEqual([
      ["api_token.create", "cli", "user", me.id],
      ["api_token.revoke", "cli", "user", me.id],
    ]);
    expect((await verifyAuditChain(db, org)).ok).toBe(true);
  });
});

describe("resolveRevokeTarget", () => {
  const m = (id: string, ownerEmail: string): ActiveTokenMatch => ({
    id,
    name: "n",
    ownerUserId: `u-${ownerEmail}`,
    orgId: "o",
    ownerEmail,
    orgName: "Org",
    createdAt: new Date(0),
  });
  const a1 = m("1", "a@x.test");
  const a2 = m("2", "a@x.test");
  const b1 = m("3", "b@x.test");

  it("none", () => {
    expect(resolveRevokeTarget([])).toEqual({ kind: "none" });
    expect(resolveRevokeTarget([a1], { email: "z@x.test" })).toEqual({ kind: "none" });
    expect(resolveRevokeTarget([a1], { id: "nope" })).toEqual({ kind: "none" });
  });
  it("exactly one resolves without flags", () => {
    expect(resolveRevokeTarget([a1])).toEqual({ kind: "one", match: a1 });
  });
  it("several asks for --email first", () => {
    expect(resolveRevokeTarget([a1, b1])).toEqual({
      kind: "ambiguous",
      matches: [a1, b1],
      next: "email",
    });
  });
  it("--email narrows (case-insensitive) to one", () => {
    expect(resolveRevokeTarget([a1, b1], { email: "B@X.test" })).toEqual({
      kind: "one",
      match: b1,
    });
  });
  it("still ambiguous after --email asks for --id, and --id resolves", () => {
    expect(resolveRevokeTarget([a1, a2, b1], { email: "a@x.test" })).toEqual({
      kind: "ambiguous",
      matches: [a1, a2],
      next: "id",
    });
    expect(resolveRevokeTarget([a1, a2, b1], { id: "2" })).toEqual({ kind: "one", match: a2 });
    expect(resolveRevokeTarget([a1, a2], { email: "a@x.test", id: "1" })).toEqual({
      kind: "one",
      match: a1,
    });
  });
});
