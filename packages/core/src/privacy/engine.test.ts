import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, organizations, platformDfsSpend } from "@opengmb/db";
import { writeAudit } from "../audit";
import { buildExport, countRows, eraseWorkspace, redactSecrets } from "./engine";
import { seedClient, type SeededClient } from "./fixture";
import { scopeWhere } from "./scope";
import { INCLUDED_TABLES } from "./tables";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

let a: SeededClient;
let b: SeededClient;
beforeAll(async () => {
  const [org] = await db.insert(organizations).values({ name: "privacy-test" }).returning();
  a = await seedClient(db, org!.id, "A");
  b = await seedClient(db, org!.id, "B");
});

/** Every row of the client, per table, as one comparable string. */
async function snapshot(workspaceId: string) {
  const out: Record<string, string> = {};
  for (const t of INCLUDED_TABLES) {
    const rows = (await db.execute(
      sql`select to_jsonb(${sql.raw(`"${t.table}"`)})::text as j from ${sql.raw(`"${t.table}"`)} where ${scopeWhere(t.table, workspaceId)} order by 1`,
    )) as unknown as { j: string }[];
    out[t.table] = rows.map((r) => r.j).join("\n");
  }
  return out;
}

describe("redactSecrets", () => {
  it("blanks secret-looking keys at any depth and keeps the rest", () => {
    const out = redactSecrets({
      a: 1,
      tokenHash: "x",
      nested: { refreshTokenEnc: "y", list: [{ token_hash: "z", keep: "k" }], password: "p" },
    });
    expect(out).toEqual({
      a: 1,
      tokenHash: "[removed]",
      nested: { refreshTokenEnc: "[removed]", list: [{ token_hash: "[removed]", keep: "k" }], password: "[removed]" },
    });
  });
});

describe("export and erase one client", () => {
  it("seeded a row in every listed table (denominator)", async () => {
    const counts = await db.transaction((tx) => countRows(tx, a.workspaceId));
    const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => t);
    console.log(`${INCLUDED_TABLES.length} tables, ${Object.values(counts).reduce((x, y) => x + y, 0)} rows seeded for client A`);
    expect(Object.keys(counts).length).toBe(INCLUDED_TABLES.length);
    expect(empty, "the fixture must put a row in each table").toEqual([]);
  });

  it("export holds every table's rows, nothing of the other client, and no secrets", async () => {
    await db.transaction((tx) =>
      writeAudit(tx, {
        orgId: a.orgId,
        actorUserId: a.userId,
        actorType: "user",
        surface: "ui",
        action: "test.secret_in_audit",
        entityType: "workspace",
        entityId: a.workspaceId,
        before: null,
        after: { tokenHash: "SHOULD_NOT_APPEAR", note: "kept" },
      }),
    );
    const ex = await db.transaction((tx) => buildExport(tx, a.workspaceId, new Date()));
    expect(ex.content).not.toContain("SHOULD_NOT_APPEAR");
    expect(ex.content).toContain('"note": "kept"');
    const doc = JSON.parse(ex.content) as { tables: Record<string, Record<string, unknown>[]>; counts: Record<string, number> };
    for (const t of INCLUDED_TABLES) {
      expect(doc.tables[t.table]!.length, t.table).toBe(doc.counts[t.table]);
      expect(doc.tables[t.table]!.length, t.table).toBeGreaterThan(0);
      for (const col of t.omit ?? []) {
        for (const row of doc.tables[t.table]!) expect(col in row, `${t.table}.${col}`).toBe(false);
      }
    }
    expect(doc.tables.audit_log!.length).toBeGreaterThan(0);
    expect(ex.content).toContain(a.mark);
    expect(ex.content).not.toContain(b.mark);
    expect(ex.content.match(/"(refresh_token_enc|token_hash|password\w*)":/)?.[0]).toBeUndefined();
  });

  it("erase empties client A in every table and leaves client B byte for byte", async () => {
    const beforeB = await snapshot(b.workspaceId);
    // Excluded tables must survive: the platform cost row loses only its location link. (Org credit: engine.private.test.ts.)
    const [spend] = await db.insert(platformDfsSpend).values({ kind: "test", locationId: a.seeded.locations, costUsd: "0.01" }).returning();
    const deleted = await db.transaction((tx) => eraseWorkspace(tx, a.workspaceId));
    expect(Object.values(deleted).every((n) => n > 0)).toBe(true);
    const afterA = await snapshot(a.workspaceId);
    expect(Object.entries(afterA).filter(([, v]) => v !== "").map(([t]) => t)).toEqual([]);
    expect(await snapshot(b.workspaceId)).toEqual(beforeB);
    const kept = (await db.execute(
      sql`select (select location_id from platform_dfs_spend where id = ${spend!.id}) as loc,
                 (select count(*)::int from platform_dfs_spend where id = ${spend!.id}) as spend`,
    )) as unknown as { loc: string | null; spend: number }[];
    expect(kept[0]).toEqual({ loc: null, spend: 1 });
    // the audit chain is kept
    const left = (await db.execute(
      sql`select count(*)::int as n from audit_log where entity_id = ${a.workspaceId}`,
    )) as unknown as { n: number }[];
    expect(left[0]!.n).toBeGreaterThan(0);
  });
});
