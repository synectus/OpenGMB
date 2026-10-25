import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, createDb, memberships, organizations, users } from "@opengmb/db";
import type { Db } from "@opengmb/db";
import { loadActor } from "./actor";
import { writeAudit } from "./audit";
import { CoreError } from "./errors";
import { executeAction } from "./executor";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeUser(d: Db) {
  const id = `u-${uniq()}`;
  await d.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  return id;
}

async function fixture() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const ownerId = await makeUser(db);
  await db.insert(memberships).values({ orgId, userId: ownerId, role: "owner" });
  const managerId = await makeUser(db);
  await db.insert(memberships).values({ orgId, userId: managerId, role: "manager" });
  const owner = await loadActor(db, { userId: ownerId, surface: "ui", actorType: "user" });
  const manager = await loadActor(db, { userId: managerId, surface: "ui", actorType: "user" });
  return { orgId, owner, manager };
}

async function seed(orgId: string, n: number, after: (i: number) => unknown = (i) => ({ i })) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      await db.transaction((tx) =>
        writeAudit(tx, {
          orgId,
          actorUserId: null,
          actorType: "system",
          surface: "worker",
          action: "test.write",
          entityType: "thing",
          entityId: String(i),
          before: null,
          after: after(i),
        }),
      ),
    );
    await sleep(3); // distinct created_at milliseconds
  }
  return rows;
}

type Out = {
  format: string;
  content: string;
  rowCount: number;
  truncated: boolean;
  nextAfterId?: number;
  checkpoint: { orgId: string; lastId: number; lastHash: string; rowCount: number } | null;
};

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, embedded CR/LF). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    out.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") endField();
    else if (c === "\r" && text[i + 1] === "\n") {
      endRow();
      i++;
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return out;
}

const exportAs = (actor: Awaited<ReturnType<typeof fixture>>["owner"], input: object) =>
  executeAction(db, actor, "audit.export", input) as Promise<Out>;

describe("audit.verify", () => {
  it("returns ok for an intact chain and is FORBIDDEN for manager", async () => {
    const { orgId, owner, manager } = await fixture();
    await seed(orgId, 2);
    expect(await executeAction(db, owner, "audit.verify", {})).toEqual({
      ok: true,
      checked: 2,
      breaks: [],
      checkpoint: "ok",
    });
    await expect(executeAction(db, manager, "audit.verify", {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("audit.export", () => {
  it("is FORBIDDEN for manager and for client roles, and writes nothing", async () => {
    const { orgId, manager } = await fixture();
    await seed(orgId, 1);
    for (const actor of [
      manager,
      { ...manager, role: "client_viewer" as const },
      { ...manager, role: "client_approver" as const },
    ]) {
      for (const name of ["audit.export", "audit.verify"]) {
        let code = "no error";
        try {
          await executeAction(db, actor, name, { format: "csv" });
        } catch (e) {
          code = e instanceof CoreError ? e.code : `other:${String(e)}`;
        }
        expect(code, `${actor.role} ${name}`).toBe("FORBIDDEN");
      }
    }
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("CSV round-trips commas, quotes and newlines inside jsonb", async () => {
    const { orgId, owner } = await fixture();
    const nasty = { note: 'a,b "quoted"\nline2\r\nline3', list: [1, "x,y"], nested: { q: '"' } };
    await seed(orgId, 1, () => nasty);
    const res = await exportAs(owner, { format: "csv" });
    expect(res.rowCount).toBe(1);
    const grid = parseCsv(res.content);
    expect(grid[0]).toEqual([
      "id",
      "created_at",
      "actor_user_id",
      "actor_type",
      "surface",
      "action",
      "entity_type",
      "entity_id",
      "before",
      "after",
      "prev_hash",
      "hash",
    ]);
    expect(grid).toHaveLength(2);
    expect(grid[1]).toHaveLength(12);
    expect(JSON.parse(grid[1]![9]!)).toEqual(nasty);
    expect(grid[1]![8]).toBe(""); // before is null
    expect(grid[1]![5]).toBe("test.write");
  });

  it("JSON format parses and carries the signed checkpoint", async () => {
    const { orgId, owner } = await fixture();
    const rows = await seed(orgId, 3);
    const res = await exportAs(owner, { format: "json" });
    const parsed = JSON.parse(res.content) as Array<{ id: number; after: unknown; hash: string }>;
    expect(parsed.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(parsed[0]!.after).toEqual({ i: 0 });
    expect(parsed.map((r) => r.hash)).toEqual(rows.map((r) => r.hash));
    // checkpoint was read after the export's own audit row was written
    const [exportRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "audit.export")));
    expect(exportRow).toMatchObject({ entityType: "audit_log", entityId: orgId, surface: "ui" });
    expect(exportRow!.after).toMatchObject({ format: "json", rowCount: 3, truncated: false });
    expect(res.checkpoint).toMatchObject({
      orgId,
      lastId: exportRow!.id,
      lastHash: exportRow!.hash,
      rowCount: 4,
    });
    expect((await executeAction(db, owner, "audit.verify", {})) as { ok: boolean }).toMatchObject({
      ok: true,
    });
  });

  it("from is inclusive and to is exclusive (UTC)", async () => {
    const { orgId, owner } = await fixture();
    const r = await seed(orgId, 4);
    const ids = (o: Out) => (JSON.parse(o.content) as { id: number }[]).map((x) => x.id);
    const t = (i: number) => r[i]!.createdAt.toISOString();
    expect(ids(await exportAs(owner, { format: "json", from: t(1), to: t(3) }))).toEqual([
      r[1]!.id,
      r[2]!.id,
    ]);
    expect(ids(await exportAs(owner, { format: "json", from: t(2) }))).toEqual(
      expect.arrayContaining([r[2]!.id, r[3]!.id]),
    );
    expect(ids(await exportAs(owner, { format: "json", to: t(0) }))).toEqual([]);
    // a non-UTC offset is converted, not read as UTC
    const shifted = new Date(r[1]!.createdAt.getTime() + 5.5 * 3600_000);
    const offset = `${shifted.toISOString().slice(0, 23)}+05:30`;
    expect(ids(await exportAs(owner, { format: "json", from: offset, to: t(2) }))).toEqual([
      r[1]!.id,
    ]);
  });

  it("limit, truncated and nextAfterId page without gaps or overlap", async () => {
    const { orgId, owner } = await fixture();
    const r = await seed(orgId, 5);
    const ids = (o: Out) => (JSON.parse(o.content) as { id: number }[]).map((x) => x.id);
    const p1 = await exportAs(owner, { format: "json", limit: 2 });
    expect(p1).toMatchObject({ rowCount: 2, truncated: true, nextAfterId: r[1]!.id });
    const p2 = await exportAs(owner, { format: "json", limit: 2, afterId: p1.nextAfterId });
    expect(p2).toMatchObject({ rowCount: 2, truncated: true, nextAfterId: r[3]!.id });
    const p3 = await exportAs(owner, { format: "json", limit: 2, afterId: p2.nextAfterId });
    // page 3: the last seeded row plus the audit.export rows written by pages 1 and 2
    expect(ids(p3)[0]).toBe(r[4]!.id);
    expect(p3.nextAfterId === undefined).toBe(!p3.truncated);
    expect([...ids(p1), ...ids(p2), ...ids(p3)].slice(0, 5)).toEqual(r.map((x) => x.id));
    const exact = await exportAs(owner, {
      format: "json",
      limit: 1,
      afterId: r[3]!.id,
      to: r[4]!.createdAt.toISOString(),
    });
    expect(exact).toMatchObject({ rowCount: 0, truncated: false });
    expect(exact.nextAfterId).toBeUndefined();
  });

  it("rejects limit above 5000 and a malformed date", async () => {
    const { owner } = await fixture();
    await expect(exportAs(owner, { format: "csv", limit: 5001 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(exportAs(owner, { format: "csv", from: "yesterday" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
