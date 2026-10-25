import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, createDb, memberships, organizations, users, workspaces } from "@opengmb/db";
import { loadActor, type Actor } from "../actor";
import { CoreError } from "../errors";
import { executeAction } from "../executor";
import { countRows } from "./engine";
import { seedClient, type SeededClient } from "./fixture";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

let orgId: string;
let a: SeededClient;
let b: SeededClient;
const actors: Record<string, Actor> = {};

async function staff(role: "owner" | "admin" | "manager", org: string) {
  const id = `u-${role}-${uniq()}`;
  await db.insert(users).values({ id, name: role, email: `${id}@example.test` });
  await db.insert(memberships).values({ orgId: org, userId: id, role });
  return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
}

beforeAll(async () => {
  const [org] = await db.insert(organizations).values({ name: `priv-${uniq()}` }).returning();
  orgId = org!.id;
  a = await seedClient(db, orgId, "A");
  b = await seedClient(db, orgId, "B");
  actors.owner = await staff("owner", orgId);
  actors.admin = await staff("admin", orgId);
  actors.manager = await staff("manager", orgId);
  actors.client = await loadActor(db, { userId: a.userId, orgId, surface: "ui", actorType: "user" });
  const [other] = await db.insert(organizations).values({ name: `priv-other-${uniq()}` }).returning();
  actors.otherOwner = await staff("owner", other!.id);
});

const countsOf = async (ws: string) => db.transaction((tx) => countRows(tx, ws));

describe("workspaces.export_data and workspaces.erase_data", () => {
  it("export: owner and admin only, own organization only", async () => {
    expect(await codeOf(run(actors.manager!, "workspaces.export_data", { workspaceId: a.workspaceId }))).toBe("FORBIDDEN");
    expect(await codeOf(run(actors.client!, "workspaces.export_data", { workspaceId: a.workspaceId }))).toBe("FORBIDDEN");
    expect(await codeOf(run(actors.otherOwner!, "workspaces.export_data", { workspaceId: a.workspaceId }))).toBe("NOT_FOUND");
    const out = await run<{ content: string; rowCount: number; filename: string }>(actors.admin!, "workspaces.export_data", {
      workspaceId: a.workspaceId,
    });
    expect(out.rowCount).toBeGreaterThan(40);
    expect(out.filename).toMatch(/^opengmb-client-.*\.json$/);
    expect(out.content).toContain(a.mark);
    expect(out.content).not.toContain(b.mark);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, a.workspaceId), eq(auditLog.action, "workspace.export")));
    expect(row).toBeDefined();
    expect(JSON.stringify(row!.after)).not.toContain(a.mark);
  });

  it("erase: owner only, the exact name, leaves the other client and a tombstone", async () => {
    const input = { workspaceId: a.workspaceId, confirmName: a.name };
    expect(await codeOf(run(actors.admin!, "workspaces.erase_data", input))).toBe("FORBIDDEN");
    expect(await codeOf(run(actors.manager!, "workspaces.erase_data", input))).toBe("FORBIDDEN");
    expect(await codeOf(run(actors.otherOwner!, "workspaces.erase_data", input))).toBe("NOT_FOUND");
    expect(await codeOf(run(actors.owner!, "workspaces.erase_data", { ...input, confirmName: a.name.toLowerCase() }))).toBe("INVALID_INPUT");
    expect(await codeOf(run(actors.owner!, "workspaces.erase_data", { ...input, confirmName: "" }))).toBe("INVALID_INPUT");
    const stillA = await countsOf(a.workspaceId);
    expect(stillA.reviews).toBeGreaterThan(0);

    const beforeB = await countsOf(b.workspaceId);
    const out = await run<{ erased: boolean; counts: Record<string, number> }>(actors.owner!, "workspaces.erase_data", input);
    expect(out.erased).toBe(true);
    expect(out.counts.reviews).toBe(stillA.reviews);
    expect(Object.values(await countsOf(a.workspaceId)).every((n) => n === 0)).toBe(true);
    expect(await countsOf(b.workspaceId)).toEqual(beforeB);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, b.workspaceId))).toHaveLength(1);

    const [tomb] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, a.workspaceId), eq(auditLog.action, "workspace.erase")));
    expect(tomb).toBeDefined();
    expect(tomb!.actorUserId).toBe(actors.owner!.userId);
    expect(tomb!.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(tomb)).not.toContain(a.mark);
    expect((tomb!.after as { counts: Record<string, number> }).counts.reviews).toBe(stillA.reviews);

    // The org's audit chain is still intact after the erase.
    const verify = await run<{ ok: boolean }>(actors.owner!, "audit.verify");
    expect(verify.ok).toBe(true);
    // A second erase finds nothing.
    expect(await codeOf(run(actors.owner!, "workspaces.erase_data", input))).toBe("NOT_FOUND");
  });
});
