import { afterAll, describe, expect, it } from "vitest";
import { and, count, eq, ne } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  createDb,
  locations,
  mcpProposals,
  memberships,
  organizations,
  reviewReplies,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { authorizeAction, loadActor, type Actor } from "./actor";
import { createApiToken, verifyApiToken } from "./apiTokens";
import { MCP_CONFIG } from "./config/mcp";
import { CoreError } from "./errors";
import { executeAction, executeToolCall } from "./executor";
import { actions } from "./actions";
import { verifyAuditChain } from "./audit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

type Role = "owner" | "manager" | "client_approver" | "client_viewer";

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mkUser = async (role: Role, workspaceId?: string) => {
    const id = `u-${uniq()}`;
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email };
  };
  /** A real token row, verified the way the MCP endpoint does it, so scopes are the production ones. */
  const mkToken = async (u: { id: string; email: string }, readOnly = false) => {
    const { token, row } = await createApiToken(db, {
      email: u.email,
      readOnly,
      mode: "full_autonomy",
    });
    return { actor: await verifyApiToken(db, token), tokenId: row.id, token };
  };
  return { orgId, wsA: ws!.id, mkUser, mkToken };
}

/** makeOrg creates workspace A. */
const BASE_WORKSPACES = 1;

const countRows = async (orgId: string) => {
  const [w] = await db.select({ n: count() }).from(workspaces).where(eq(workspaces.orgId, orgId));
  const [a] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), ne(auditLog.action, "mcp.proposal_created")));
  const [p] = await db
    .select({ n: count() })
    .from(mcpProposals)
    .where(eq(mcpProposals.orgId, orgId));
  return { workspaces: w!.n, otherAudit: a!.n, proposals: p!.n };
};

type Proposed = {
  proposalId: string;
  expiresAt: string;
  preview: { summary: string; diff: unknown; findings: { ok: boolean; violations: unknown[] } };
};
const propose = (actor: Actor, name: string, input: unknown) =>
  executeToolCall(db, actor, name, input) as Promise<Proposed>;
const apply = (actor: Actor, proposalId: string) =>
  executeToolCall(db, actor, "mcp.proposals.apply", { proposalId }) as Promise<{
    status: string;
    result: { workspace: { id: string; name: string } };
  }>;

describe("two-phase writes over MCP", () => {
  it("propose writes only the proposal row; apply runs it once; a second apply is CONFLICT", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor, tokenId } = await org.mkToken(owner);
    const before = await countRows(org.orgId);

    const name = `Two phase ${uniq()}`;
    const p = await propose(actor, "workspaces.create", { name });
    expect(p.proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.preview.summary).toContain(name);
    expect(p.preview.findings).toMatchObject({ ok: true, violations: [] });
    const ttl = new Date(p.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(MCP_CONFIG.proposalTtlMs - 10_000);
    expect(ttl).toBeLessThanOrEqual(MCP_CONFIG.proposalTtlMs);

    // Nothing but the proposal row (and its audit row) exists yet.
    expect(await countRows(org.orgId)).toEqual({ ...before, proposals: before.proposals + 1 });
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(row).toMatchObject({
      status: "pending",
      action: "workspaces.create",
      tokenId,
      userId: owner.id,
      orgId: org.orgId,
      input: { name },
    });
    const created = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "mcp.proposal_created")));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ surface: "mcp", actorType: "api_token" });

    const applied = await apply(actor, p.proposalId);
    expect(applied.status).toBe("applied");
    expect(applied.result.workspace.name).toBe(name);
    const ws = await db.select().from(workspaces).where(eq(workspaces.orgId, org.orgId));
    expect(ws.filter((w) => w.name === name)).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "workspace.create")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ surface: "mcp", actorType: "api_token" });
    const [done] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(done).toMatchObject({ status: "applied" });
    expect(done!.appliedAt).not.toBeNull();

    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
    const after = await db.select().from(workspaces).where(eq(workspaces.orgId, org.orgId));
    expect(after.filter((w) => w.name === name)).toHaveLength(1);
    expect((await verifyAuditChain(db, org.orgId)).ok).toBe(true);
  });

  it("dryRun and a plain call both return a proposal and have no side effect besides it", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const before = await countRows(org.orgId);
    const a = await propose(actor, "workspaces.create", { name: "Dry", dryRun: true });
    const b = await propose(actor, "workspaces.create", { name: "Dry" });
    expect(a.proposalId).not.toBe(b.proposalId);
    expect(await countRows(org.orgId)).toEqual({ ...before, proposals: before.proposals + 2 });
  });

  it("invalid input is INVALID_INPUT and stores no proposal; a missing token id is FORBIDDEN", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    const before = await countRows(org.orgId);
    expect(await codeOf(propose(actor, "workspaces.create", { name: "" }))).toBe("INVALID_INPUT");
    expect(await countRows(org.orgId)).toEqual(before);
    const noToken: Actor = { ...actor, apiTokenId: undefined };
    expect(await codeOf(propose(noToken, "workspaces.create", { name: "x" }))).toBe("FORBIDDEN");
  });

  it("an expired proposal cannot be applied and is marked expired", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const p = await propose(actor, "workspaces.create", { name: `Expiring ${uniq()}` });
    await db
      .update(mcpProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpProposals.id, p.proposalId));
    const list = (await executeToolCall(db, actor, "mcp.proposals.list", {})) as {
      proposals: { proposalId: string; status: string }[];
    };
    expect(list.proposals.find((x) => x.proposalId === p.proposalId)?.status).toBe("expired");
    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(row!.status).toBe("expired");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("only the creating token and user can apply or cancel; another organisation sees NOT_FOUND", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    const otherToken = await org.mkToken(owner);
    const manager = await org.mkToken(await org.mkUser("manager"));
    const stranger = await makeOrg();
    const strangerTok = await stranger.mkToken(await stranger.mkUser("owner"));

    const p = await propose(actor, "workspaces.create", { name: `Bound ${uniq()}` });
    expect(await codeOf(apply(otherToken.actor, p.proposalId))).toBe("FORBIDDEN");
    expect(await codeOf(apply(manager.actor, p.proposalId))).toBe("FORBIDDEN");
    expect(await codeOf(apply(strangerTok.actor, p.proposalId))).toBe("NOT_FOUND");
    expect(
      await codeOf(
        executeToolCall(db, otherToken.actor, "mcp.proposals.cancel", { proposalId: p.proposalId }),
      ),
    ).toBe("FORBIDDEN");
    const mine = (await executeToolCall(db, otherToken.actor, "mcp.proposals.list", {})) as {
      proposals: unknown[];
    };
    expect(mine.proposals).toHaveLength(0);
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
    expect((await apply(actor, p.proposalId)).status).toBe("applied");
  });

  it("the stored input is what runs: a tampered row is refused", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const p = await propose(actor, "workspaces.create", { name: "Original" });
    await db
      .update(mcpProposals)
      .set({ input: { name: "Tampered" } })
      .where(eq(mcpProposals.id, p.proposalId));
    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("authorization is re-checked at apply: a role downgrade after proposing is FORBIDDEN", async () => {
    const org = await makeOrg();
    const manager = await org.mkUser("manager");
    const { actor, token } = await org.mkToken(manager);
    const p = await propose(actor, "workspaces.create", { name: `Downgrade ${uniq()}` });
    await db
      .update(memberships)
      .set({ role: "client_viewer", workspaceId: org.wsA })
      .where(eq(memberships.userId, manager.id));
    const fresh = await verifyApiToken(db, token); // what the next MCP request would load
    expect(fresh.role).toBe("client_viewer");
    expect(await codeOf(apply(fresh, p.proposalId))).toBe("FORBIDDEN");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("a blocking finding keeps the proposal from applying; cancel ends it", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const name = `Dup ${uniq()}`;
    await db.insert(workspaces).values({ orgId: org.orgId, name });
    const p = await propose(actor, "workspaces.create", { name });
    expect(p.preview.findings.ok).toBe(false);
    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(row!.status).toBe("pending");

    const c = (await executeToolCall(db, actor, "mcp.proposals.cancel", {
      proposalId: p.proposalId,
    })) as { status: string };
    expect(c.status).toBe("cancelled");
    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
  });

  it("an unknown stored action applies nothing", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const p = await propose(actor, "workspaces.create", { name: `Gone ${uniq()}` });
    await db
      .update(mcpProposals)
      .set({ action: "workspaces.nope" })
      .where(eq(mcpProposals.id, p.proposalId));
    expect(await codeOf(apply(actor, p.proposalId))).toBe("NOT_FOUND");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("an action that fails inside apply marks the proposal failed, keeps nothing and cannot be retried", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const before = await countRows(org.orgId);
    // Valid input, no preview-level problem: the handler itself fails (group does not exist).
    const p = await propose(actor, "locationGroups.rename", {
      groupId: crypto.randomUUID(),
      name: "Renamed",
    });
    expect(p.preview.findings.ok).toBe(true);
    expect(await codeOf(apply(actor, p.proposalId))).toBe("NOT_FOUND");
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/^NOT_FOUND: /);
    expect(await codeOf(apply(actor, p.proposalId))).toBe("CONFLICT");
    expect(await countRows(org.orgId)).toEqual({ ...before, proposals: before.proposals + 1 });
  });

  it("apiTokens.create over MCP is refused before any proposal exists", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const before = await countRows(org.orgId);
    expect(await codeOf(propose(actor, "apiTokens.create", { name: "x" }))).toBe("FORBIDDEN");
    expect(await countRows(org.orgId)).toEqual(before);
  });
});

describe("own_flow actions are not double-gated", () => {
  async function reviewFixture(org: Awaited<ReturnType<typeof makeOrg>>) {
    const [loc] = await db
      .insert(locations)
      .values({ orgId: org.orgId, workspaceId: org.wsA, name: "Clinic", phone: "555-0100" })
      .returning();
    const now = new Date();
    const [rev] = await db
      .insert(reviews)
      .values({
        orgId: org.orgId,
        workspaceId: org.wsA,
        locationId: loc!.id,
        googleReviewName: `accounts/1/locations/2/reviews/${uniq()}`,
        reviewerDisplayName: "Pat",
        starRating: 5,
        comment: "Great place",
        createTime: now,
        updateTime: now,
      })
      .returning();
    return rev!;
  }
  const replyCount = async (reviewId: string) =>
    (
      await db
        .select({ n: count() })
        .from(reviewReplies)
        .where(eq(reviewReplies.reviewId, reviewId))
    )[0]!.n;

  it("dryRun returns guardrail findings and writes nothing; the real call executes directly", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const rev = await reviewFixture(org);
    const before = await countRows(org.orgId);

    const dry = (await executeToolCall(db, actor, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: "Visit https://example.com/offer today",
      dryRun: true,
    })) as { dryRun: boolean; preview: Proposed["preview"] };
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.findings.ok).toBe(false);
    expect(JSON.stringify(dry.preview.findings.violations)).toContain("U7.url");
    expect(await replyCount(rev.id)).toBe(0);
    expect(await countRows(org.orgId)).toEqual(before);

    // No proposal, no apply step: reviewReplies has its own draft -> submit -> approve flow.
    const real = (await executeToolCall(db, actor, "reviewReplies.createDraft", {
      reviewId: rev.id,
      body: "Thank you for the kind words.",
    })) as { reply: { id: string; status: string } };
    expect(real.reply.status).toBe("draft");
    expect(await replyCount(rev.id)).toBe(1);
    expect((await countRows(org.orgId)).proposals).toBe(before.proposals);

    // updateDraft previews against the existing reply's review.
    const upd = (await executeToolCall(db, actor, "reviewReplies.updateDraft", {
      id: real.reply.id,
      body: "Call 555-123-4567 now https://x.example",
      dryRun: true,
    })) as { preview: Proposed["preview"] };
    expect(upd.preview.findings.ok).toBe(false);
    const [stored] = await db
      .select()
      .from(reviewReplies)
      .where(eq(reviewReplies.id, real.reply.id));
    expect(stored!.body).toBe("Thank you for the kind words.");
  });

  it("every registered write action has an approval mode and a callable preview or generic one", async () => {
    const own = actions.filter((a) => a.kind === "write" && a.approval === "own_flow");
    const names = own.map((a) => a.name);
    for (const n of [
      "reviewReplies.submit",
      "reviewReplies.approve",
      "reviewReplies.publish",
      "posts.submit",
      "posts.approve",
      "posts.schedule",
      "profile.propose",
      "profile.apply",
      "profile.changes.accept",
      "mcp.proposals.apply",
    ]) {
      expect(names, n).toContain(n);
    }
    expect(actions.find((a) => a.name === "workspaces.create")!.approval).toBeUndefined();
  });
});

describe("token scopes", () => {
  it("a read-only token is FORBIDDEN on every write (dryRun included) but reads; core enforces it", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner, true);
    expect(actor.scopes).toEqual(["read"]);
    const before = await countRows(org.orgId);

    for (const input of [{ name: "RO" }, { name: "RO", dryRun: true }]) {
      expect(await codeOf(executeToolCall(db, actor, "workspaces.create", input))).toBe(
        "FORBIDDEN",
      );
    }
    await expect(executeToolCall(db, actor, "workspaces.create", { name: "RO" })).rejects.toThrow(
      /read-only/,
    );
    // The same refusal one layer down: the executor does not need the MCP gate to say no.
    expect(await codeOf(executeAction(db, actor, "workspaces.create", { name: "RO" }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await codeOf(executeToolCall(db, actor, "reviewReplies.createDraft", { dryRun: true })),
    ).toBe("FORBIDDEN");
    expect(await countRows(org.orgId)).toEqual(before);

    expect(await codeOf(executeToolCall(db, actor, "workspaces.list", {}))).toBe("no error");
    expect(await codeOf(executeToolCall(db, actor, "mcp.proposals.list", {}))).toBe("no error");
    expect(await codeOf(executeToolCall(db, actor, "audit.list", {}))).toBe("no error");
  });

  it("a read & write token still passes, and a web session is not scope-limited", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    expect(actor.scopes).toEqual(["read", "write"]);
    const ui = await loadActor(db, { userId: owner.id, surface: "ui", actorType: "user" });
    expect(ui.scopes).toBeUndefined();
    expect(await codeOf(executeAction(db, ui, "workspaces.create", { name: `UI ${uniq()}` }))).toBe(
      "no error",
    );
  });

  it("client_viewer cannot create a write token, and a viewer's token is read-only whatever the row says", async () => {
    const org = await makeOrg();
    const viewer = await org.mkUser("client_viewer", org.wsA);
    const ui = await loadActor(db, { userId: viewer.id, surface: "ui", actorType: "user" });

    expect(
      await codeOf(
        executeAction(db, ui, "apiTokens.create", { name: "w", scopes: ["read", "write"] }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(executeAction(db, ui, "apiTokens.create", { name: "w", scopes: ["write"] })),
    ).toBe("FORBIDDEN");
    const made = (await executeAction(db, ui, "apiTokens.create", { name: "default" })) as {
      token: string;
      apiToken: { scopes: string[]; id: string };
    };
    expect(made.apiToken.scopes).toEqual(["read"]);
    const cli = await createApiToken(db, { email: viewer.email });
    expect(cli.row.scopes).toEqual(["read"]);

    await db
      .update(apiTokens)
      .set({ scopes: ["read", "write"] })
      .where(eq(apiTokens.id, made.apiToken.id));
    const actor = await verifyApiToken(db, made.token);
    expect(actor.scopes).toEqual(["read"]);
  });

  it("other roles choose: scopes omitted = read & write, [read] = read-only", async () => {
    const org = await makeOrg();
    const manager = await org.mkUser("manager");
    const ui = await loadActor(db, { userId: manager.id, surface: "ui", actorType: "user" });
    const scopesOf = async (input: object) =>
      (
        (await executeAction(db, ui, "apiTokens.create", { name: "t", ...input })) as {
          apiToken: { scopes: string[] };
        }
      ).apiToken.scopes;
    expect(await scopesOf({})).toEqual(["read", "write"]);
    expect(await scopesOf({ scopes: ["read"] })).toEqual(["read"]);
    expect(await scopesOf({ scopes: ["write"] })).toEqual(["read", "write"]);
    const list = (await executeAction(db, ui, "apiTokens.list", {})) as {
      tokens: { scopes: string[] }[];
    };
    expect(list.tokens.map((t) => t.scopes.join("+")).sort()).toEqual([
      "read",
      "read+write",
      "read+write",
    ]);
  });

  it("a client_approver token with write may approve or reject, nothing else", async () => {
    const org = await makeOrg();
    const approver = await org.mkUser("client_approver", org.wsA);
    const { actor } = await org.mkToken(approver);
    expect(actor.scopes).toEqual(["read", "write"]);
    const approve = actions.find((a) => a.name === "reviewReplies.approve")!;
    expect(() => authorizeAction(actor, approve)).not.toThrow();
    const revoke = actions.find((a) => a.name === "apiTokens.revoke")!;
    expect(() => authorizeAction(actor, revoke)).toThrow(/client_approver token may only approve/);
    // The same actor on the web (no scopes) keeps the old behaviour.
    const ui = await loadActor(db, { userId: approver.id, surface: "ui", actorType: "user" });
    expect(() => authorizeAction(ui, revoke)).not.toThrow();
  });
});

describe("web session apply and cancel (plan 5A rule)", () => {
  const web = (u: { id: string }) =>
    loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
  const webApply = (actor: Actor, proposalId: string) =>
    executeAction(db, actor, "mcp.proposals.apply", { proposalId }) as Promise<{
      status: string;
      result: { workspace: { id: string; name: string } };
    }>;
  const webCancel = (actor: Actor, proposalId: string) =>
    executeAction(db, actor, "mcp.proposals.cancel", { proposalId }) as Promise<{ status: string }>;
  type Listed = {
    proposalId: string;
    status: string;
    tokenId: string;
    tokenName: string;
    tokenRevoked: boolean;
  };
  const list = (actor: Actor, input: object = {}) =>
    executeAction(db, actor, "mcp.proposals.list", input) as Promise<{ proposals: Listed[] }>;

  it("the token's owner applies from the web; the write is audited as the app", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor, tokenId } = await org.mkToken(owner);
    const name = `Web apply ${uniq()}`;
    const p = await propose(actor, "workspaces.create", { name });

    const applied = await webApply(await web(owner), p.proposalId);
    expect(applied.status).toBe("applied");
    expect(applied.result.workspace.name).toBe(name);

    const created = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "workspace.create")));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ surface: "ui", actorType: "user", actorUserId: owner.id });
    const [done] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "mcp.proposal_applied")));
    expect(done!.after).toMatchObject({ status: "applied", via: "web", tokenId });

    expect(await codeOf(webApply(await web(owner), p.proposalId))).toBe("CONFLICT");
    expect((await verifyAuditChain(db, org.orgId)).ok).toBe(true);
  });

  it("nobody else can: another owner is FORBIDDEN, another organisation NOT_FOUND", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    const p = await propose(actor, "workspaces.create", { name: `Not yours ${uniq()}` });

    const colleague = await web(await org.mkUser("owner"));
    expect(await codeOf(webApply(colleague, p.proposalId))).toBe("FORBIDDEN");
    expect(await codeOf(webCancel(colleague, p.proposalId))).toBe("FORBIDDEN");
    const stranger = await makeOrg();
    const s = await web(await stranger.mkUser("owner"));
    expect(await codeOf(webApply(s, p.proposalId))).toBe("NOT_FOUND");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("a worker or system actor without a token is FORBIDDEN even for the owner's user id", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    const p = await propose(actor, "workspaces.create", { name: `System ${uniq()}` });
    const sys: Actor = { ...(await web(owner)), surface: "worker", actorType: "system" };
    expect(await codeOf(webApply(sys, p.proposalId))).toBe("FORBIDDEN");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("the policy check runs again at a web apply", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor } = await org.mkToken(owner);
    const name = `Late duplicate ${uniq()}`;
    const p = await propose(actor, "workspaces.create", { name });
    expect(p.preview.findings.ok).toBe(true);
    await db.insert(workspaces).values({ orgId: org.orgId, name });
    expect(await codeOf(webApply(await web(owner), p.proposalId))).toBe("CONFLICT");
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(row!.status).toBe("pending");
  });

  it("the role is checked again at a web apply", async () => {
    const org = await makeOrg();
    const manager = await org.mkUser("manager");
    const { actor } = await org.mkToken(manager);
    const p = await propose(actor, "workspaces.create", { name: `Downgraded ${uniq()}` });
    await db
      .update(memberships)
      .set({ role: "client_viewer", workspaceId: org.wsA })
      .where(eq(memberships.userId, manager.id));
    expect(await codeOf(webApply(await web(manager), p.proposalId))).toBe("FORBIDDEN");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
  });

  it("a revoked token's proposal cannot be applied from the web, but can be cancelled", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const { actor, tokenId } = await org.mkToken(owner);
    const p = await propose(actor, "workspaces.create", { name: `Revoked ${uniq()}` });
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));

    const me = await web(owner);
    expect(await codeOf(webApply(me, p.proposalId))).toBe("FORBIDDEN");
    expect((await countRows(org.orgId)).workspaces).toBe(BASE_WORKSPACES);
    expect((await webCancel(me, p.proposalId)).status).toBe("cancelled");
    const [listed] = (await list(me, { status: "cancelled" })).proposals;
    expect(listed).toMatchObject({ proposalId: p.proposalId, tokenRevoked: true });
  });

  it("the web list shows the person's proposals from every token, with names, and nobody else's", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const t1 = await org.mkToken(owner);
    const t2 = await org.mkToken(owner);
    await db
      .update(apiTokens)
      .set({ name: "Claude Desktop (Perry)" })
      .where(eq(apiTokens.id, t2.tokenId));
    const other = await org.mkToken(await org.mkUser("owner"));
    const p1 = await propose(t1.actor, "workspaces.create", { name: `One ${uniq()}` });
    const p2 = await propose(t2.actor, "workspaces.create", { name: `Two ${uniq()}` });
    const p3 = await propose(other.actor, "workspaces.create", { name: `Three ${uniq()}` });

    const mine = (await list(await web(owner))).proposals;
    expect(mine.map((p) => p.proposalId).sort()).toEqual([p1.proposalId, p2.proposalId].sort());
    expect(mine.find((p) => p.proposalId === p2.proposalId)).toMatchObject({
      tokenId: t2.tokenId,
      tokenName: "Claude Desktop (Perry)",
      tokenRevoked: false,
    });
    expect(mine.some((p) => p.proposalId === p3.proposalId)).toBe(false);
    // Over MCP a token still sees only its own.
    const viaT1 = (await executeToolCall(db, t1.actor, "mcp.proposals.list", {})) as {
      proposals: Listed[];
    };
    expect(viaT1.proposals.map((p) => p.proposalId)).toEqual([p1.proposalId]);
  });
});

describe("listing proposals by status", () => {
  type Listed = { proposals: { proposalId: string; status: string }[] };
  const listVia = (actor: Actor, input: object) =>
    executeToolCall(db, actor, "mcp.proposals.list", input) as Promise<Listed>;

  it("filters before the limit, so an older cancelled proposal is still found", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const first = await propose(actor, "workspaces.create", { name: `Old ${uniq()}` });
    await executeToolCall(db, actor, "mcp.proposals.cancel", { proposalId: first.proposalId });
    for (let i = 0; i < 3; i++) {
      await propose(actor, "workspaces.create", { name: `New ${i} ${uniq()}` });
    }

    const cancelled = await listVia(actor, { status: "cancelled", limit: 1 });
    expect(cancelled.proposals.map((p) => p.proposalId)).toEqual([first.proposalId]);
    expect((await listVia(actor, { status: "pending", limit: 2 })).proposals).toHaveLength(2);
    // Denominator: every row, newest first.
    expect((await listVia(actor, { limit: 10 })).proposals).toHaveLength(4);
  });

  it("expired is filterable, and a row past its expiry is never listed as pending", async () => {
    const org = await makeOrg();
    const { actor } = await org.mkToken(await org.mkUser("owner"));
    const a = await propose(actor, "workspaces.create", { name: `A ${uniq()}` });
    const b = await propose(actor, "workspaces.create", { name: `B ${uniq()}` });
    // Stored status stays 'pending'; only the clock moved past it.
    await db
      .update(mcpProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpProposals.id, a.proposalId));

    const expired = await listVia(actor, { status: "expired", limit: 1 });
    expect(expired.proposals).toEqual([
      expect.objectContaining({ proposalId: a.proposalId, status: "expired" }),
    ]);
    const pending = await listVia(actor, { status: "pending", limit: 10 });
    expect(pending.proposals.map((p) => p.proposalId)).toEqual([b.proposalId]);
  });
});
