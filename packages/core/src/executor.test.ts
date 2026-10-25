import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog, createDb, memberships, organizations, users, workspaces } from "@opengmb/db";
import type { Db } from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { InvalidInputError, executeAction } from "./executor";
import { defineAction } from "./registry";
import { actions } from "./actions";
import { verifyAuditChain } from "./audit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(d: Db) {
  const id = `u-${uniq()}`;
  await d.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  return id;
}

/** An org with an owner, workspaces A and B, and a client_viewer who can only see A. */
async function fixture() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const ownerId = await makeUser(db);
  await db.insert(memberships).values({ orgId, userId: ownerId, role: "owner" });
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A-ws" },
      { orgId, name: "B-ws" },
    ])
    .returning();
  const viewerId = await makeUser(db);
  await db
    .insert(memberships)
    .values({ orgId, userId: viewerId, role: "client_viewer", workspaceId: a!.id });
  const owner = await loadActor(db, { userId: ownerId, surface: "ui", actorType: "user" });
  const viewer = await loadActor(db, { userId: viewerId, surface: "ui", actorType: "user" });
  return { orgId, owner, viewer, a: a!, b: b! };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

describe("executeAction", () => {
  it("has a non-empty registry", () => {
    expect(actions.length).toBeGreaterThan(0);
    expect(new Set(actions.map((a) => a.name)).size).toBe(actions.length);
  });

  it("unknown action -> NOT_FOUND", async () => {
    const { owner } = await fixture();
    expect(await codeOf(executeAction(db, owner, "nope.nothing", {}))).toBe("NOT_FOUND");
  });

  it("write action that skips audit throws and rolls back", async () => {
    const { owner, orgId } = await fixture();
    const sneaky = defineAction({
      name: "test.sneaky",
      description: "writes without auditing",
      input: z.object({}),
      output: z.object({}),
      permission: "workspace:create",
      kind: "write",
      async handler({ tx, actor }) {
        await tx.insert(workspaces).values({ orgId: actor.orgId, name: "sneaky" });
        return {};
      },
    });
    await expect(executeAction(db, owner, "test.sneaky", {}, [sneaky])).rejects.toThrow(
      /wrote no audit row/,
    );
    const rows = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.name, "sneaky")));
    expect(rows).toHaveLength(0);
  });

  it("read action may write no audit row", async () => {
    const { owner } = await fixture();
    await expect(executeAction(db, owner, "workspaces.list", {})).resolves.toBeDefined();
  });

  it("invalid input -> INVALID_INPUT with issues", async () => {
    const { owner } = await fixture();
    for (const bad of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(101) }, { name: 5 }]) {
      expect(await codeOf(executeAction(db, owner, "workspaces.create", bad))).toBe(
        "INVALID_INPUT",
      );
    }
    const err = await executeAction(db, owner, "workspaces.create", { name: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as InvalidInputError).issues[0]?.path).toEqual(["name"]);
    expect(await codeOf(executeAction(db, owner, "audit.list", { limit: 101 }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("client_viewer is FORBIDDEN on workspaces.create and audit.list", async () => {
    const { viewer, orgId } = await fixture();
    expect(await codeOf(executeAction(db, viewer, "workspaces.create", { name: "x" }))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(executeAction(db, viewer, "audit.list", {}))).toBe("FORBIDDEN");
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, orgId));
    expect(rows).toHaveLength(0);
  });

  it("workspaces.list: owner sees all, client_viewer only their workspace, ordered by name", async () => {
    const { owner, viewer, a, b } = await fixture();
    const all = (await executeAction(db, owner, "workspaces.list", {})) as {
      workspaces: { id: string; name: string; createdAt: string }[];
    };
    expect(all.workspaces.map((w) => w.id)).toEqual([a.id, b.id]);
    expect(Date.parse(all.workspaces[0]!.createdAt)).not.toBeNaN();
    const mine = (await executeAction(db, viewer, "workspaces.list", {})) as {
      workspaces: { id: string }[];
    };
    expect(mine.workspaces.map((w) => w.id)).toEqual([a.id]);
  });

  it("workspaces.list never leaks another org's workspaces", async () => {
    const one = await fixture();
    const two = await fixture();
    const res = (await executeAction(db, one.owner, "workspaces.list", {})) as {
      workspaces: { id: string }[];
    };
    expect(res.workspaces.map((w) => w.id)).not.toContain(two.a.id);
  });

  it("workspaces.create audits with surface/actor from the actor; duplicate -> CONFLICT", async () => {
    const { owner, orgId } = await fixture();
    const mcpActor: Actor = { ...owner, surface: "mcp", actorType: "api_token" };
    const out = (await executeAction(db, mcpActor, "workspaces.create", { name: "  Fresh  " })) as {
      workspace: { id: string; name: string };
    };
    expect(out.workspace.name).toBe("Fresh");

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "workspace.create")));
    expect(row).toMatchObject({
      surface: "mcp",
      actorType: "api_token",
      actorUserId: owner.userId,
      entityType: "workspace",
      entityId: out.workspace.id,
      before: null,
    });
    expect((row!.after as { name: string }).name).toBe("Fresh");

    expect(await codeOf(executeAction(db, owner, "workspaces.create", { name: "Fresh" }))).toBe(
      "CONFLICT",
    );
    const dupAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "workspace.create")));
    expect(dupAudits).toHaveLength(1);
    expect((await verifyAuditChain(db, orgId)).ok).toBe(true);
  });

  it("audit.list returns the org's entries newest first and pages with beforeId", async () => {
    const { owner } = await fixture();
    for (const n of ["p1", "p2", "p3"])
      await executeAction(db, owner, "workspaces.create", { name: n });
    type Out = { entries: { id: number; action: string; createdAt: string }[] };
    const page1 = (await executeAction(db, owner, "audit.list", { limit: 2 })) as Out;
    expect(page1.entries).toHaveLength(2);
    expect(page1.entries[0]!.id).toBeGreaterThan(page1.entries[1]!.id);
    const page2 = (await executeAction(db, owner, "audit.list", {
      limit: 2,
      beforeId: page1.entries[1]!.id,
    })) as Out;
    expect(page2.entries[0]!.id).toBeLessThan(page1.entries[1]!.id);
    expect(page1.entries.every((e) => e.action === "workspace.create")).toBe(true);
  });
});
