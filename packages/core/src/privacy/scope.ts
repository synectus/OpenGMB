import { sql, type SQL } from "drizzle-orm";
import { INCLUDED_TABLES } from "./tables";

const ident = (name: string) => sql.raw(`"${name}"`);

/** The SQL condition (on the bare table name) that selects the client's rows of `table`. */
export function scopeWhere(table: string, workspaceId: string): SQL {
  const spec = INCLUDED_TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`privacy: ${table} is not a listed table`);
  const s = spec.scope;
  switch (s.kind) {
    case "self":
      return sql`${ident(table)}.id = ${workspaceId}`;
    case "workspace":
      return sql`${ident(table)}.workspace_id = ${workspaceId}`;
    case "location":
      return sql`${ident(table)}.location_id in (select id from locations where workspace_id = ${workspaceId})`;
    case "parent":
      return sql`${ident(table)}.${ident(s.column)} in (select id from ${ident(s.parent)} where ${scopeWhere(s.parent, workspaceId)})`;
  }
}
