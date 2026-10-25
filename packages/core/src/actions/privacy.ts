import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "@opengmb/db";
import { AccessError, authorize } from "../actor";
import { CoreError } from "../errors";
import { buildExport, countRows, eraseWorkspace } from "../privacy/engine";
import { defineAction } from "../registry";

type Tx = Parameters<Parameters<typeof defineAction>[0]["handler"]>[0]["tx"];

const loadClient = async (tx: Tx, orgId: string, workspaceId: string) => {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)));
  if (!row) throw new AccessError("NOT_FOUND", "Client not found");
  return row;
};

export const workspacesExportData = defineAction({
  name: "workspaces.export_data",
  description:
    "Export everything OpenGMB stores for one client (workspace) as one JSON document: locations, reviews, replies, assignments and notes, posts and edits, profile snapshots and changes, media records, reports, templates, people, and the audit rows about the client. Never includes secrets (Google tokens, API token hashes, passwords, two-factor secrets, one-time and share-link token hashes) or anything held only on Google. Refused above 1,000,000 rows. Each export is recorded in the audit log (counts only). Needs workspace:manage (owner, admin).",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({
    filename: z.string(),
    content: z.string(),
    rowCount: z.number().int(),
    counts: z.record(z.string(), z.number().int()),
  }),
  permission: "workspace:manage",
  // Read: no tenant data changes (same as audit.export); the handler records the export explicitly.
  kind: "read",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "workspace:manage", { workspaceId: input.workspaceId });
    const w = await loadClient(tx, actor.orgId, input.workspaceId);
    const exportedAt = new Date();
    const ex = await buildExport(tx, w.id, exportedAt);
    await audit({
      action: "workspace.export",
      entityType: "workspace",
      entityId: w.id,
      before: null,
      after: { rowCount: ex.rowCount, counts: ex.counts, auditRows: ex.auditRows },
    });
    return {
      filename: `opengmb-client-${w.id}-${exportedAt.toISOString().slice(0, 10)}.json`,
      content: ex.content,
      rowCount: ex.rowCount,
      counts: { ...ex.counts, audit_log: ex.auditRows },
    };
  },
});

export const workspacesEraseData = defineAction({
  name: "workspaces.erase_data",
  description:
    "Permanently delete one client (workspace) and everything OpenGMB stores for it: locations, reviews, replies, posts, profile history, media records, reports, templates and people's access, in one transaction. confirmName must equal the client's name exactly. Does NOT delete anything on Google (posts, replies, profile edits already published stay there), does not delete people's accounts or the agency's Google connection, and keeps the audit log (append-only; it is the proof of this erasure). Leaves one tombstone audit row with the client id and row counts, no personal data. Export first: this cannot be undone. Needs workspace:erase (owner only).",
  input: z.object({ workspaceId: z.uuid(), confirmName: z.string().max(200) }),
  output: z.object({ erased: z.boolean(), counts: z.record(z.string(), z.number().int()) }),
  permission: "workspace:erase",
  kind: "write",
  async preview({ readTx, actor }, input) {
    const { name, counts } = await readTx(async (tx) => {
      const w = await loadClient(tx, actor.orgId, input.workspaceId);
      return { name: w.name, counts: await countRows(tx, w.id) };
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      summary:
        input.confirmName === name
          ? `Would permanently delete client "${name}" and ${total} rows. Google-side content stays on Google.`
          : `confirmName does not match the client name; applying would fail.`,
      diff: { before: counts, after: null },
    };
  },
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "workspace:erase", { workspaceId: input.workspaceId });
    const w = await loadClient(tx, actor.orgId, input.workspaceId);
    if (input.confirmName !== w.name) {
      throw new CoreError("INVALID_INPUT", "Type the client's name exactly to confirm the deletion.");
    }
    await tx.execute(sql`select id from workspaces where id = ${w.id} for update`);
    const counts = await eraseWorkspace(tx, w.id);
    await audit({
      action: "workspace.erase",
      entityType: "workspace",
      entityId: w.id,
      before: null,
      after: { erased: true, counts },
    });
    return { erased: true, counts };
  },
});
