import { afterAll, describe, expect, it } from "vitest";
import { createDb, memberships, organizations, users } from "@opengmb/db";
import { loadActor } from "./actor";
import { writeAudit, type AuditEntry } from "./audit";
import { CoreError } from "./errors";
import { executeAction } from "./executor";

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

type Entry = {
  id: number;
  actorUserId: string | null;
  actorName: string | null;
  actorType: string;
  surface: string;
  action: string;
  before: unknown;
  after: unknown;
};
type Out = { entries: Entry[] };

/** An org with an owner "Perry" and a manager "Priya", and four audit rows, oldest first. */
async function fixture() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const mk = async (name: string, role: "owner" | "manager") => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name, email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role });
    return id;
  };
  const ownerId = await mk("Perry", "owner");
  const managerId = await mk("Priya", "manager");
  const write = (e: Partial<AuditEntry> & Pick<AuditEntry, "action">) =>
    db.transaction((tx) =>
      writeAudit(tx, {
        orgId,
        actorUserId: null,
        actorType: "system",
        surface: "worker",
        entityType: "thing",
        entityId: "1",
        before: null,
        after: { n: 1 },
        ...e,
      }),
    );
  await write({
    action: "t.app",
    actorUserId: ownerId,
    actorType: "user",
    surface: "ui",
    before: { name: "Old" },
    after: { name: "New" },
  });
  await write({ action: "t.token", actorUserId: ownerId, actorType: "api_token", surface: "mcp" });
  await write({ action: "t.worker" });
  await write({ action: "t.manager", actorUserId: managerId, actorType: "user", surface: "ui" });
  const owner = await loadActor(db, { userId: ownerId, surface: "ui", actorType: "user" });
  const manager = await loadActor(db, { userId: managerId, surface: "ui", actorType: "user" });
  return { ownerId, managerId, owner, manager };
}

const list = (actor: Awaited<ReturnType<typeof fixture>>["owner"], input: object = {}) =>
  executeAction(db, actor, "audit.list", input) as Promise<Out>;
const actions = (o: Out) => o.entries.map((e) => e.action);

describe("audit.list filters and names", () => {
  it("without filters: every row, newest first, with the actor's name and the change", async () => {
    const f = await fixture();
    const out = await list(f.owner);
    expect(actions(out)).toEqual(["t.manager", "t.worker", "t.token", "t.app"]);
    expect(out.entries.map((e) => e.actorName)).toEqual(["Priya", null, "Perry", "Perry"]);
    expect(out.entries[3]).toMatchObject({ before: { name: "Old" }, after: { name: "New" } });
  });

  it("filters by surface, including one with no rows", async () => {
    const f = await fixture();
    const mcp = await list(f.owner, { surface: "mcp" });
    expect(actions(mcp)).toEqual(["t.token"]);
    expect(mcp.entries[0]).toMatchObject({ actorType: "api_token", actorName: "Perry" });
    expect(actions(await list(f.owner, { surface: "worker" }))).toEqual(["t.worker"]);
    expect(actions(await list(f.owner, { surface: "cli" }))).toEqual([]);
  });

  it("filters by actor, alone and together with surface", async () => {
    const f = await fixture();
    expect(actions(await list(f.owner, { actorUserId: f.ownerId }))).toEqual(["t.token", "t.app"]);
    expect(actions(await list(f.owner, { actorUserId: f.ownerId, surface: "ui" }))).toEqual(["t.app"]);
    expect(actions(await list(f.owner, { actorUserId: f.managerId }))).toEqual(["t.manager"]);
  });

  it("filters run before the limit, and paging with beforeId keeps them", async () => {
    const f = await fixture();
    const p1 = await list(f.owner, { actorUserId: f.ownerId, limit: 1 });
    expect(actions(p1)).toEqual(["t.token"]);
    const p2 = await list(f.owner, { actorUserId: f.ownerId, limit: 1, beforeId: p1.entries[0]!.id });
    expect(actions(p2)).toEqual(["t.app"]);
    const p3 = await list(f.owner, { actorUserId: f.ownerId, limit: 1, beforeId: p2.entries[0]!.id });
    expect(p3.entries).toEqual([]);
  });

  it("an unknown surface is INVALID_INPUT; a manager (no audit:read) is FORBIDDEN", async () => {
    const f = await fixture();
    expect(await codeOf(list(f.owner, { surface: "email" }))).toBe("INVALID_INPUT");
    expect(await codeOf(list(f.manager))).toBe("FORBIDDEN");
  });
});
