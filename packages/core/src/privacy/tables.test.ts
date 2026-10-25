import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@opengmb/db";
import { EXCLUDED_TABLES, INCLUDED_NAMES, INCLUDED_TABLES, OTHER_SCHEMAS, SECRET_COLUMN } from "./tables";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

async function dbTables(): Promise<string[]> {
  const rows = await client<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;
  return rows.map((r) => r.table_name).sort();
}

describe("privacy table registry covers the whole schema", () => {
  it("lists every table, with a canary and a denominator", async () => {
    const tables = await dbTables();
    expect(tables.length, "no tables found: the check inspected nothing").toBeGreaterThan(0);
    expect(tables, "canary table missing: the extractor is broken").toContain("reviews");
    const listed = new Set([...INCLUDED_NAMES, ...Object.keys(EXCLUDED_TABLES)]);
    const missing = tables.filter((t) => !listed.has(t));
    const stale = [...listed].filter((t) => !tables.includes(t));
    console.log(
      `${tables.length} tables: ${INCLUDED_NAMES.length} exported and deleted, ${Object.keys(EXCLUDED_TABLES).length} excluded with a reason`,
    );
    expect({ missing, stale }, "add each new table to INCLUDED_TABLES or EXCLUDED_TABLES").toEqual({
      missing: [],
      stale: [],
    });
    const both = INCLUDED_NAMES.filter((t) => t in EXCLUDED_TABLES);
    expect(both).toEqual([]);
    expect(new Set(INCLUDED_NAMES).size).toBe(INCLUDED_NAMES.length);
  });

  it("never excludes a table that carries workspace_id, and every scope column exists", async () => {
    const cols = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const has = (t: string, c: string) => cols.some((x) => x.table_name === t && x.column_name === c);
    const withWs = [...new Set(cols.filter((c) => c.column_name === "workspace_id").map((c) => c.table_name))];
    expect(withWs.length, "no table has workspace_id: the check inspected nothing").toBeGreaterThan(5);
    expect(withWs.filter((t) => !INCLUDED_NAMES.includes(t))).toEqual([]);
    const withLoc = [...new Set(cols.filter((c) => c.column_name === "location_id").map((c) => c.table_name))];
    // A table whose only link to a location is ON DELETE SET NULL (platform accounting) may be excluded:
    // erasing the client nulls the link and keeps the row.
    const setNull = await client<{ child: string }[]>`
      select c.conrelid::regclass::text as child from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confdeltype = 'n' and a.attname = 'location_id'`;
    const setNullTables = setNull.map((r) => r.child);
    expect(setNullTables, "canary: set-null location fk seen").toContain("platform_dfs_spend");
    expect(withLoc.filter((t) => !INCLUDED_NAMES.includes(t) && !setNullTables.includes(t))).toEqual([]);
    for (const t of INCLUDED_TABLES) {
      const col =
        t.scope.kind === "workspace" ? "workspace_id" : t.scope.kind === "location" ? "location_id" : t.scope.kind === "parent" ? t.scope.column : "id";
      expect(has(t.table, col), `${t.table}.${col}`).toBe(true);
      for (const o of t.omit ?? []) expect(has(t.table, o), `${t.table}.${o} (omit)`).toBe(true);
      if (t.scope.kind === "parent") expect(INCLUDED_NAMES, `${t.table} parent`).toContain(t.scope.parent);
    }
  });

  it("is in delete order: no table is listed before a table that points at it", async () => {
    const fks = await client<{ child: string; parent: string }[]>`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`;
    expect(fks.length).toBeGreaterThan(50);
    const idx = (t: string) => INCLUDED_NAMES.indexOf(t);
    const wrong = fks
      .filter((f) => f.child !== f.parent && idx(f.child) >= 0 && idx(f.parent) >= 0 && idx(f.child) > idx(f.parent))
      .map((f) => `${f.child} must be deleted before ${f.parent}`);
    expect(wrong).toEqual([]);
  });

  it("no excluded table points at an included one, except with ON DELETE SET NULL, so delete cannot hit a foreign key", async () => {
    const fks = await client<{ child: string; parent: string; del: string }[]>`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.confdeltype::text as del
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`;
    expect(fks.some((f) => f.child === "platform_dfs_spend" && f.del === "n"), "canary: set-null fk seen").toBe(true);
    const bad = fks.filter((f) => f.child in EXCLUDED_TABLES && INCLUDED_NAMES.includes(f.parent) && f.del !== "n");
    expect(bad).toEqual([]);
  });

  it("the database has no schema nobody decided about", async () => {
    const rows = await client<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema'`;
    const names = rows.map((r) => r.nspname);
    expect(names).toContain("public"); // canary
    expect(names.filter((n) => n !== "public" && !OTHER_SCHEMAS.includes(n))).toEqual([]);
  });

  it("an included table with a secret-looking column names it in omit", async () => {
    const cols = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const leaks = cols
      .filter((c) => INCLUDED_NAMES.includes(c.table_name) && SECRET_COLUMN.test(c.column_name))
      .filter((c) => !INCLUDED_TABLES.find((t) => t.table === c.table_name)?.omit?.includes(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(leaks).toEqual([]);
    // canary: the pattern still matches a known secret column
    expect(SECRET_COLUMN.test("token_hash")).toBe(true);
  });
});
void db;
