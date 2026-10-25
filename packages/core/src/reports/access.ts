import { and, eq } from "drizzle-orm";
import { reportDefinitions, reportRuns, users } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import type { Reader } from "../performance/queries";
import { reportFilename } from "./share";

/** A report definition in the actor's org and workspace scope, or NOT_FOUND (never FORBIDDEN, so ids cannot be probed). */
export async function loadDefinitionForActor(q: Reader, actor: Actor, id: string) {
  const [def] = await q
    .select()
    .from(reportDefinitions)
    .where(and(eq(reportDefinitions.id, id), eq(reportDefinitions.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  if (!def || (scope !== "all" && !scope.includes(def.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Report definition not found");
  }
  return def;
}

/** The run columns every caller needs (never the PDF bytes), plus the requester's name. */
export const runColumns = {
  id: reportRuns.id,
  orgId: reportRuns.orgId,
  definitionId: reportRuns.definitionId,
  periodStart: reportRuns.periodStart,
  periodEnd: reportRuns.periodEnd,
  status: reportRuns.status,
  trigger: reportRuns.trigger,
  pdfBytes: reportRuns.pdfBytes,
  error: reportRuns.error,
  emailedAt: reportRuns.emailedAt,
  createdAt: reportRuns.createdAt,
  finishedAt: reportRuns.finishedAt,
  requestedByName: users.name,
};

/** A report run (metadata, no PDF bytes) whose definition is in the actor's scope. */
export async function loadRunForActor(q: Reader, actor: Actor, runId: string) {
  const [run] = await q
    .select(runColumns)
    .from(reportRuns)
    .leftJoin(users, eq(users.id, reportRuns.requestedBy))
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.orgId, actor.orgId)));
  if (!run) throw new AccessError("NOT_FOUND", "Report run not found");
  const def = await loadDefinitionForActor(q, actor, run.definitionId);
  return { run, def };
}

/**
 * The PDF of a finished run, after authorization (report:read plus workspace scope). The one place
 * both the `reports.download` action and the web download route get bytes from.
 */
export async function loadReportPdf(
  db: Reader,
  actor: Actor,
  runId: string,
): Promise<{ pdf: Buffer; filename: string; runId: string }> {
  authorize(actor, "report:read");
  const { run, def } = await loadRunForActor(db, actor, runId);
  if (run.status !== "done") throw new CoreError("CONFLICT", "The report is not ready");
  const [row] = await db
    .select({ pdf: reportRuns.pdf })
    .from(reportRuns)
    .where(eq(reportRuns.id, run.id));
  if (!row?.pdf) throw new CoreError("CONFLICT", "The report has no PDF");
  return {
    pdf: row.pdf,
    filename: reportFilename(def.name, run.periodStart, run.periodEnd),
    runId: run.id,
  };
}
