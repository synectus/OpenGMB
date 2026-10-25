import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_RESOURCES,
  actions,
  createApiToken,
  executeAction,
  loadActor,
  roleHasPermission,
  verifyApiToken,
  type Actor,
} from "@opengmb/core";
import {
  createDb,
  locations,
  memberships,
  organizations,
  profileChanges,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { createMcpServer } from "./server";
import { RESOURCE_URIS } from "./resources";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Role = "owner" | "manager" | "client_approver" | "client_viewer";

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const mkUser = async (role: Role, workspaceId?: string) => {
    const id = `u-${uniq()}`;
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email };
  };
  const mkToken = async (
    u: { id: string; email: string },
    readOnly = false,
    mode: "human_in_the_loop" | "full_autonomy" = "full_autonomy",
  ) => {
    const { token } = await createApiToken(db, { email: u.email, readOnly, mode });
    return verifyApiToken(db, token);
  };
  const owner = await mkUser("owner");
  const ownerUi = await loadActor(db, { userId: owner.id, surface: "ui", actorType: "user" });
  /** A 2-star review with a submitted reply (2 stars are never auto-approved) in `workspaceId`. */
  const pendingReply = async (workspaceId: string) => {
    const [loc] = await db
      .insert(locations)
      .values({ orgId, workspaceId, name: `Clinic ${uniq()}`, phone: "555-0100" })
      .returning();
    const now = new Date();
    const [rev] = await db
      .insert(reviews)
      .values({
        orgId,
        workspaceId,
        locationId: loc!.id,
        googleReviewName: `accounts/1/locations/2/reviews/${uniq()}`,
        reviewerDisplayName: "Pat",
        starRating: 2,
        comment: "Slow service",
        createTime: now,
        updateTime: now,
      })
      .returning();
    const { reply } = (await executeAction(db, ownerUi, "reviewReplies.createDraft", {
      reviewId: rev!.id,
      body: "We are sorry to hear that.",
    })) as { reply: { id: string } };
    await executeAction(db, ownerUi, "reviewReplies.submit", { id: reply.id });
    return { reviewId: rev!.id, replyId: reply.id, locationId: loc!.id };
  };
  const googleUpdate = async (locationId: string) => {
    const [c] = await db
      .insert(profileChanges)
      .values({
        orgId,
        locationId,
        source: "push",
        fieldPaths: ["title"],
        before: { fields: { title: "Old" }, attributes: {} },
        after: { fields: { title: "New" }, attributes: {} },
        googleSuggested: true,
      })
      .returning();
    return c!.id;
  };
  return { orgId, a: a!.id, b: b!.id, mkUser, mkToken, pendingReply, googleUpdate };
}

async function connect(actor: Actor) {
  const server = createMcpServer({ db, actor, actions });
  const client = new Client({ name: "surface-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const readJson = async (client: Client, uri: string) => {
  const res = await client.readResource({ uri });
  expect(res.contents).toHaveLength(1);
  expect(res.contents[0]).toMatchObject({ uri, mimeType: "application/json" });
  return JSON.parse((res.contents[0] as { text: string }).text);
};
const codeOfCall = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0]!.text).code as string;

describe("MCP resources", () => {
  it("resources/list names the three resources", async () => {
    const org = await makeOrg();
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(Object.values(RESOURCE_URIS).sort());
    expect(resources.every((r) => r.mimeType === "application/json")).toBe(true);
    await client.close();
  });

  it("MCP_RESOURCES is the registered list: same URIs, names and descriptions", async () => {
    const org = await makeOrg();
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    const { resources } = await client.listResources();
    const listed = resources.map((r) => `${r.name} ${r.uri} ${r.description}`).sort();
    const declared = MCP_RESOURCES.map((r) => `${r.name} ${r.uri} ${r.description}`).sort();
    expect(listed).toEqual(declared);
    expect(declared).toHaveLength(Object.values(RESOURCE_URIS).length);
    await client.close();
  });

  it("introduces itself as opengmb", async () => {
    const org = await makeOrg();
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    expect(client.getServerVersion()?.name).toBe("opengmb");
    expect(Object.values(RESOURCE_URIS).every((u) => u.startsWith("opengmb://"))).toBe(true);
    await client.close();
  });

  it("still answers the old syngmb:// addresses with the same data, without listing them", async () => {
    const org = await makeOrg();
    await org.pendingReply(org.a);
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("syngmb://"))).toEqual([]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["syngmb://{group}/{name}"]);
    let checked = 0;
    for (const uri of Object.values(RESOURCE_URIS)) {
      const legacy = uri.replace(/^opengmb:/, "syngmb:");
      // readJson asserts contents[0].uri echoes the address that was asked for.
      expect(await readJson(client, legacy), legacy).toEqual(await readJson(client, uri));
      checked++;
    }
    expect(checked).toBe(3);
    await expect(client.readResource({ uri: "syngmb://reviews/nope" })).rejects.toThrow(/not found/);
    await client.close();
  });

  it("an old address checks permissions exactly like the new one", async () => {
    const org = await makeOrg();
    const viewer = await connect(await org.mkToken(await org.mkUser("client_viewer", org.a)));
    await expect(viewer.readResource({ uri: "syngmb://reviews/queue" })).rejects.toThrow();
    await expect(viewer.readResource({ uri: RESOURCE_URIS.reviewQueue })).rejects.toThrow();
    await viewer.close();
  });

  it("each resource is readable by exactly the roles that hold its declared permission", async () => {
    const org = await makeOrg();
    await org.pendingReply(org.a);
    const roles: Role[] = ["owner", "manager", "client_approver", "client_viewer"];
    let checked = 0;
    for (const role of roles) {
      const u = await org.mkUser(role, role.startsWith("client") ? org.a : undefined);
      const client = await connect(await org.mkToken(u));
      for (const r of MCP_RESOURCES) {
        const ok = await client.readResource({ uri: r.uri }).then(
          () => true,
          () => false,
        );
        // One string per cell so a failure names the role and the resource.
        expect(`${role} ${r.name} ${ok}`).toBe(
          `${role} ${r.name} ${roleHasPermission(role, r.permission)}`,
        );
        checked++;
      }
      await client.close();
    }
    expect(checked).toBe(roles.length * MCP_RESOURCES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an owner reads the review queue, pending Google updates and the audit log", async () => {
    const org = await makeOrg();
    const pending = await org.pendingReply(org.a);
    const changeId = await org.googleUpdate(pending.locationId);
    const client = await connect(await org.mkToken(await org.mkUser("owner")));

    const queue = await readJson(client, RESOURCE_URIS.reviewQueue);
    expect(Object.keys(queue.replies).sort()).toEqual(["blocked", "conflict", "pending_approval"]);
    expect(Object.keys(queue.posts).sort()).toEqual(["blocked", "pending_approval"]);
    expect(
      queue.replies.pending_approval.map((i: { reply: { id: string } }) => i.reply.id),
    ).toEqual([pending.replyId]);

    const updates = await readJson(client, RESOURCE_URIS.pendingUpdates);
    expect(updates.changes.map((c: { id: string }) => c.id)).toEqual([changeId]);
    expect(updates.changes[0]).toMatchObject({ googleSuggested: true, status: "open" });

    const audit = await readJson(client, RESOURCE_URIS.auditRecent);
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(audit.entries.length).toBeLessThanOrEqual(100);
    expect(audit.entries.map((e: { action: string }) => e.action)).toContain(
      "review_reply.draft_created",
    );
    await client.close();
  });

  it("resources are scoped through core: a workspace approver sees only their workspace", async () => {
    const org = await makeOrg();
    const inA = await org.pendingReply(org.a);
    const inB = await org.pendingReply(org.b);
    await org.googleUpdate(inB.locationId);
    const approver = await org.mkUser("client_approver", org.a);
    const client = await connect(await org.mkToken(approver));

    const queue = await readJson(client, RESOURCE_URIS.reviewQueue);
    const ids = queue.replies.pending_approval.map((i: { reply: { id: string } }) => i.reply.id);
    expect(ids).toEqual([inA.replyId]);
    expect(ids).not.toContain(inB.replyId);
    expect((await readJson(client, RESOURCE_URIS.pendingUpdates)).changes).toEqual([]);
    await client.close();
  });

  it("permission denial: a client_viewer cannot read the queue, nobody below admin reads the audit log", async () => {
    const org = await makeOrg();
    const viewer = await connect(await org.mkToken(await org.mkUser("client_viewer", org.a)));
    await expect(viewer.readResource({ uri: RESOURCE_URIS.reviewQueue })).rejects.toThrow(
      /FORBIDDEN/,
    );
    await expect(viewer.readResource({ uri: RESOURCE_URIS.auditRecent })).rejects.toThrow(
      /FORBIDDEN/,
    );
    // location:read is enough for pending updates.
    expect((await readJson(viewer, RESOURCE_URIS.pendingUpdates)).changes).toEqual([]);
    await viewer.close();

    const manager = await connect(await org.mkToken(await org.mkUser("manager")));
    await expect(manager.readResource({ uri: RESOURCE_URIS.auditRecent })).rejects.toThrow(
      /audit:read/,
    );
    await manager.close();
  });

  it("a read-only token still reads every resource", async () => {
    const org = await makeOrg();
    await org.pendingReply(org.a);
    const client = await connect(await org.mkToken(await org.mkUser("owner"), true));
    for (const uri of Object.values(RESOURCE_URIS)) await readJson(client, uri);
    await client.close();
  });
});

describe("MCP write tools", () => {
  it("a two_phase tool returns a proposal that satisfies its output schema; apply is a tool", async () => {
    const org = await makeOrg();
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    const name = `Via tool ${uniq()}`;
    const res = await client.callTool({ name: "workspaces_create", arguments: { name } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      proposalId: string;
      expiresAt: string;
      preview: { summary: string; diff: unknown; findings: { ok: boolean } };
    };
    expect(out.proposalId).toBeTruthy();
    expect(out.preview.findings.ok).toBe(true);
    expect(out).not.toHaveProperty("workspace");

    const dry = await client.callTool({
      name: "workspaces_create",
      arguments: { name, dryRun: true },
    });
    expect(dry.structuredContent).toHaveProperty("proposalId");

    const applied = await client.callTool({
      name: "mcp_proposals_apply",
      arguments: { proposalId: out.proposalId },
    });
    expect(applied.isError).toBeFalsy();
    const again = await client.callTool({
      name: "mcp_proposals_apply",
      arguments: { proposalId: out.proposalId },
    });
    expect(again.isError).toBe(true);
    expect(codeOfCall(again)).toBe("CONFLICT");
    await client.close();
  });

  it("an own_flow tool that changes Google is refused to a token, and dryRun previews it", async () => {
    const org = await makeOrg();
    const pending = await org.pendingReply(org.a);
    const client = await connect(await org.mkToken(await org.mkUser("owner")));
    const dry = await client.callTool({
      name: "reviewReplies_approve",
      arguments: { id: pending.replyId, dryRun: true },
    });
    expect(dry.isError).toBeFalsy();
    expect(dry.structuredContent).toMatchObject({ dryRun: true });
    const real = await client.callTool({
      name: "reviewReplies_approve",
      arguments: { id: pending.replyId },
    });
    // Q33d: approving a reply leads to a Google write, so even a full-autonomy token is refused.
    expect(real.isError).toBe(true);
    expect(codeOfCall(real)).toBe("FORBIDDEN");
    expect(JSON.stringify(real)).toMatch(/A person must approve this in OpenGMB/);
    expect(JSON.stringify(real)).toContain("/approvals");
    await client.close();
  });

  it("a human-in-the-loop token cannot approve, publish or apply; a full-autonomy token can apply internal proposals but not Google writes (Z5a, Q33d)", async () => {
    const org = await makeOrg();
    const owner = await org.mkUser("owner");
    const hitl = await connect(await org.mkToken(owner, false, "human_in_the_loop"));
    const pending = await org.pendingReply(org.a);

    const refused = await hitl.callTool({
      name: "reviewReplies_approve",
      arguments: { id: pending.replyId },
    });
    expect(refused.isError).toBe(true);
    expect(codeOfCall(refused)).toBe("FORBIDDEN");
    expect(JSON.stringify(refused)).toMatch(/A person must approve this in OpenGMB/);
    const publish = await hitl.callTool({
      name: "reviewReplies_publish",
      arguments: { id: pending.replyId },
    });
    expect(codeOfCall(publish)).toBe("FORBIDDEN");

    // It can still draft: a two_phase tool returns a proposal, but applying one is refused.
    const proposal = await hitl.callTool({
      name: "workspaces_create",
      arguments: { name: `Hitl ${uniq()}` },
    });
    expect(proposal.isError).toBeFalsy();
    const apply = await hitl.callTool({
      name: "mcp_proposals_apply",
      arguments: { proposalId: (proposal.structuredContent as { proposalId: string }).proposalId },
    });
    expect(codeOfCall(apply)).toBe("FORBIDDEN");
    await hitl.close();

    const full = await connect(await org.mkToken(owner, false, "full_autonomy"));
    const ok = await full.callTool({
      name: "reviewReplies_approve",
      arguments: { id: pending.replyId },
    });
    // Even full autonomy cannot approve a reply (Q33d); it can still draft and apply internal proposals.
    expect(ok.isError).toBe(true);
    expect(JSON.stringify(ok)).toMatch(/A person must approve this in OpenGMB/);
    const internal = await full.callTool({ name: "workspaces_create", arguments: { name: `Full ${uniq()}` } });
    const applied = await full.callTool({
      name: "mcp_proposals_apply",
      arguments: { proposalId: (internal.structuredContent as { proposalId: string }).proposalId },
    });
    expect(applied.isError).toBeFalsy();
    await full.close();
  });

  it("a read-only token gets FORBIDDEN from every kind of write tool but can read", async () => {
    const org = await makeOrg();
    const client = await connect(await org.mkToken(await org.mkUser("owner"), true));
    for (const [name, args] of [
      ["workspaces_create", { name: "x" }],
      ["workspaces_create", { name: "x", dryRun: true }],
      ["reviewReplies_createDraft", { reviewId: crypto.randomUUID(), body: "x", dryRun: true }],
      ["mcp_proposals_cancel", { proposalId: crypto.randomUUID() }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect(codeOfCall(res), name).toBe("FORBIDDEN");
      expect(JSON.parse((res.content as { text: string }[])[0]!.text).message).toMatch(/read-only/);
    }
    const listed = await client.callTool({ name: "workspaces_list", arguments: {} });
    expect(listed.isError).toBeFalsy();
    await client.close();
  });
});
