/**
 * Test fixture: seed one client (workspace) with a row in EVERY table of INCLUDED_TABLES, driven by
 * the registry and the foreign keys, so a new table is seeded (or the seed fails loudly) without
 * anyone editing this file. Test code only.
 */
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import * as dbSchema from "@opengmb/db";
import type { Db } from "@opengmb/db";
import { users, workspaces } from "@opengmb/db";
import { writeAudit } from "../audit";
import { PRIVATE_FIXTURE_OVERRIDES, PRIVATE_FIXTURE_USER_KEYS } from "./private";
import { INCLUDED_TABLES } from "./tables";

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const byName = new Map<string, PgTable>();
for (const v of Object.values(dbSchema)) {
  if (v instanceof PgTable) byName.set(getTableConfig(v).name, v);
}

/** Per-table values the generic seed cannot guess (check constraints, enums with a required first state). */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  posts: { status: "draft" },
  review_replies: { status: "draft" },
  grid_configs: { gridSize: 3 },
  memberships: { role: "client_approver" },
  search_keywords_monthly: { value: 5 },
  citation_entries: { siteKey: "test-site" },
};

function dummy(col: PgColumn, table: string, mark: string): unknown {
  if (col.enumValues && col.enumValues.length > 0) return col.enumValues[0];
  switch (col.dataType) {
    case "string":
      if (col.columnType === "PgUUID") return crypto.randomUUID();
      if (col.columnType === "PgNumeric") return "1";
      if (col.columnType === "PgDateString") return "2026-01-01";
      return `${mark}-${table}-${col.name}-${uniq()}`;
    case "number":
      return 1;
    case "boolean":
      return false;
    case "date":
      return new Date("2030-01-01T00:00:00Z");
    case "json":
      return {};
    case "array":
      return [`${mark}-${table}-${col.name}`];
    case "bigint":
      return 1;
    default:
      return Buffer.from("x");
  }
}

export type SeededClient = {
  mark: string;
  orgId: string;
  userId: string;
  workspaceId: string;
  name: string;
  /** table name -> id (or null for tables without an id column) of the row seeded. */
  seeded: Record<string, string | null>;
};

export async function seedClient(
  db: Db,
  orgId: string,
  tag: string,
  opts: { connectionId?: string } = {},
): Promise<SeededClient> {
  const mark = `PRIV_${tag}_${uniq()}`;
  const userId = `u-${tag}-${uniq()}`;
  await db.insert(users).values({ id: userId, name: `${mark}-user`, email: `${userId}@example.test` });
  const name = `${mark}-client`;
  const [ws] = await db.insert(workspaces).values({ orgId, name }).returning();
  const workspaceId = ws!.id;
  const seeded: Record<string, string | null> = { workspaces: workspaceId };
  seeded.google_connections =
    opts.connectionId ??
    ((await insertRow(db, "google_connections", { org_id: orgId, user_id: userId }, mark, {})).id as string);

  const ctx: Record<string, unknown> = {
    org_id: orgId,
    workspace_id: workspaceId,
    user_id: userId,
  };
  const order = INCLUDED_TABLES.filter((t) => t.table !== "workspaces").map((t) => t.table).reverse();
  for (const t of order) {
    const over: Record<string, unknown> = { ...(OVERRIDES[t] ?? PRIVATE_FIXTURE_OVERRIDES[t] ?? {}) };
    if (t === "locations") {
      over.googleLocationId = `locations/${mark}${uniq()}`;
      over.googleAccountName = `accounts/${mark}${uniq()}`;
    }
    const userKey = PRIVATE_FIXTURE_USER_KEYS[t];
    if (userKey) ctx[userKey] = userId;
    const row = await insertRow(db, t, ctx, mark, over, seeded);
    seeded[t] = (row.id as string | undefined) ?? null;
    if (t === "locations") ctx.location_id = row.id;
  }
  await db.transaction((tx) =>
    writeAudit(tx, {
      orgId,
      actorUserId: userId,
      actorType: "user",
      surface: "ui",
      action: `${mark}.seed`,
      entityType: "workspace",
      entityId: workspaceId,
      before: null,
      after: { marker: mark },
    }),
  );
  return { mark, orgId, userId, workspaceId, name, seeded };
}

export async function insertRow(
  db: Db,
  tableName: string,
  ctx: Record<string, unknown>,
  mark: string,
  over: Record<string, unknown>,
  seeded: Record<string, string | null> = {},
): Promise<Record<string, unknown>> {
  const table = byName.get(tableName);
  if (!table) throw new Error(`fixture: no drizzle table for ${tableName}`);
  const cfg = getTableConfig(table);
  const fk = new Map<string, string>();
  for (const f of cfg.foreignKeys) {
    const ref = f.reference();
    fk.set(ref.columns[0]!.name, getTableConfig(ref.foreignTable).name);
  }
  const values: Record<string, unknown> = {};
  const cols = Object.entries(table as unknown as Record<string, PgColumn>).filter(
    ([, c]) => typeof c === "object" && c !== null && "columnType" in c,
  );
  for (const [key, col] of cols) {
    if (key in over) values[key] = over[key];
    else if (col.name in ctx && (col.notNull || ["org_id", "workspace_id", "location_id"].includes(col.name)))
      values[key] = ctx[col.name];
    else if (col.notNull && !col.hasDefault) {
      const parent = fk.get(col.name);
      if (parent === "users") values[key] = ctx.user_id;
      else if (parent === "organizations") values[key] = ctx.org_id;
      else if (parent) {
        const id = seeded[parent];
        if (!id) throw new Error(`fixture: ${tableName}.${col.name} needs a seeded ${parent} row`);
        values[key] = id;
      } else values[key] = dummy(col, tableName, mark);
    }
  }
  const [row] = await db.insert(table).values(values as never).returning();
  return row as Record<string, unknown>;
}
