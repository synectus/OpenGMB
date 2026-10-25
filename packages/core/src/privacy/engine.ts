import { sql } from "drizzle-orm";
import type { Tx } from "@opengmb/db";
import { CoreError } from "../errors";
import { scopeWhere } from "./scope";
import { INCLUDED_TABLES, SECRET_COLUMN, type IncludedTable } from "./tables";

/** Above this many rows the export is refused (it is built in memory); ask support for a bulk copy. */
export const EXPORT_MAX_ROWS = 1_000_000;

const ident = (name: string) => sql.raw(`"${name}"`);
const rowsOf = <T>(r: unknown): T[] => r as T[];

/** Row counts per included table for the client. */
export async function countRows(tx: Tx, workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of INCLUDED_TABLES) {
    const r = rowsOf<{ n: number }>(
      await tx.execute(sql`select count(*)::int as n from ${ident(t.table)} where ${scopeWhere(t.table, workspaceId)}`),
    );
    out[t.table] = r[0]!.n;
  }
  return out;
}

/** Fail closed: an included table gained a secret-looking column that nobody put on the omit list. */
async function assertNoSecretColumns(tx: Tx) {
  const cols = rowsOf<{ table_name: string; column_name: string }>(
    await tx.execute(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    ),
  );
  const leaks = cols.filter((c) => {
    const spec = INCLUDED_TABLES.find((t) => t.table === c.table_name);
    return spec && SECRET_COLUMN.test(c.column_name) && !spec.omit?.includes(c.column_name);
  });
  if (leaks.length > 0) {
    throw new CoreError(
      "CONFLICT",
      `Export blocked: ${leaks.map((l) => `${l.table_name}.${l.column_name}`).join(", ")} looks like a secret and is not on the omit list`,
    );
  }
}

const selectRows = (t: IncludedTable, workspaceId: string) => {
  const omit = t.omit?.length ? sql` - ${sql.raw(`ARRAY[${t.omit.map((c) => `'${c}'`).join(",")}]::text[]`)}` : sql``;
  return sql`select to_jsonb(${ident(t.table)})${omit} as row from ${ident(t.table)} where ${scopeWhere(t.table, workspaceId)} order by 1`;
};

/** Ids of every row of the client, as text; audit rows about them belong to the export. */
const entityIdsSql = (workspaceId: string, withId: Set<string>) =>
  sql.join(
    INCLUDED_TABLES.filter((t) => t.table !== "workspaces" && withId.has(t.table)).map(
      (t) =>
        sql`select ${ident(t.table)}.id::text as id from ${ident(t.table)} where ${scopeWhere(t.table, workspaceId)}`,
    ),
    sql` union `,
  );

/** Audit before/after JSON is free-form: blank any value under a secret-looking key, at any depth. */
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[removed]" : redactSecrets(x)]),
    );
  }
  return v;
}
const SECRET_KEY = /token_?hash|_enc$|password|secret|totp|refresh_?token|api_?key/i;

export type WorkspaceExport = {
  content: string;
  counts: Record<string, number>;
  auditRows: number;
  rowCount: number;
};

export async function buildExport(tx: Tx, workspaceId: string, exportedAt: Date): Promise<WorkspaceExport> {
  await assertNoSecretColumns(tx);
  const counts = await countRows(tx, workspaceId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > EXPORT_MAX_ROWS) {
    throw new CoreError(
      "CONFLICT",
      `This client has ${total.toLocaleString("en-US")} rows, more than an export can hold (${EXPORT_MAX_ROWS.toLocaleString("en-US")}). Ask support for a bulk copy.`,
    );
  }
  const tables: Record<string, unknown[]> = {};
  for (const t of INCLUDED_TABLES) {
    tables[t.table] = rowsOf<{ row: unknown }>(await tx.execute(selectRows(t, workspaceId))).map((r) => r.row);
  }
  const withId = new Set(
    rowsOf<{ table_name: string }>(
      await tx.execute(
        sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'id'`,
      ),
    ).map((r) => r.table_name),
  );
  // Audit rows are keyed by org, not client: take those about the client or any of its rows, or that mention its id.
  const audit = rowsOf<{ row: unknown }>(
    await tx.execute(sql`
      select to_jsonb(a) as row from audit_log a
      where a.org_id = (select org_id from workspaces where id = ${workspaceId})
        and (a.entity_id = ${workspaceId}
          or a.entity_id in (${entityIdsSql(workspaceId, withId)})
          or a.before::text like ${"%" + workspaceId + "%"}
          or a.after::text like ${"%" + workspaceId + "%"})
      order by a.id`),
  ).map((r) => redactSecrets(r.row));
  const content = JSON.stringify(
    {
      exportedAt: exportedAt.toISOString(),
      workspaceId,
      note: "Everything OpenGMB stores for this client. Secrets (Google tokens, API token hashes, passwords, two-factor secrets, invitation and share link token hashes) are never included. Content on Google itself is not part of this file.",
      counts: { ...counts, audit_log: audit.length },
      tables: { ...tables, audit_log: audit },
    },
    null,
    2,
  );
  return { content, counts, auditRows: audit.length, rowCount: total + audit.length };
}

/** Deletes the client's rows, children first, in the caller's transaction. Returns rows deleted per table. */
export async function eraseWorkspace(tx: Tx, workspaceId: string): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const t of INCLUDED_TABLES) {
    const r = rowsOf<{ n: number }>(
      await tx.execute(sql`
        with d as (delete from ${ident(t.table)} where ${scopeWhere(t.table, workspaceId)} returning 1)
        select count(*)::int as n from d`),
    );
    deleted[t.table] = r[0]!.n;
  }
  return deleted;
}
