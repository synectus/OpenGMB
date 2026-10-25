import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  locationGroups,
  locations,
  reportDefinitions,
  reportRuns,
  reportLanguages,
  reportPeriods,
  reportKinds,
  reportRunStatuses,
  reportRunTriggers,
  reportSchedules,
  reportScopes,
  reportShareLinks,
  users,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { PERFORMANCE_CONFIG } from "../config/performance";
import { CoreError } from "../errors";
import { daysBetween, isYmd } from "../performance/dates";
import { MAX_RANGE_DAYS } from "../performance/queries";
import { defineAction } from "../registry";
import {
  loadDefinitionForActor,
  loadReportPdf,
  loadRunForActor,
  runColumns,
} from "../reports/access";
import { commentProblem, normalizeComment } from "../reports/labels";
import { HEX_COLOUR } from "../reports/pdf";
import { brandingOf, createManualRun, type DefinitionRow } from "../reports/run";
import { createShareLink, shareUrl } from "../reports/share";

const day = z.string().refine(isYmd, "Use YYYY-MM-DD");
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const brandingSchema = z.object({
  agencyName: z.string().trim().min(1).max(80).optional(),
  colour: z.string().regex(HEX_COLOUR, "Use #RRGGBB").optional(),
});

const definitionOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  kind: z.enum(reportKinds),
  scope: z.enum(reportScopes),
  locationIds: z.array(z.string()),
  groupId: z.string().nullable(),
  language: z.enum(reportLanguages),
  comment: z.string().nullable(),
  aiSummary: z.boolean(),
  period: z.enum(reportPeriods),
  customFrom: z.string().nullable(),
  customTo: z.string().nullable(),
  schedule: z.enum(reportSchedules),
  recipients: z.array(z.string()),
  branding: brandingSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const definitionToOut = (d: DefinitionRow): z.input<typeof definitionOut> => ({
  id: d.id,
  workspaceId: d.workspaceId,
  name: d.name,
  kind: d.kind,
  scope: d.scope,
  locationIds: d.locationIds,
  groupId: d.groupId,
  language: d.language,
  comment: d.comment,
  aiSummary: d.aiSummary,
  period: d.period,
  customFrom: d.customFrom,
  customTo: d.customTo,
  schedule: d.schedule,
  recipients: d.recipients,
  branding: brandingOf(d),
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

type RunRow = Awaited<ReturnType<typeof loadRunForActor>>["run"];

const runOut = z.object({
  id: z.string(),
  definitionId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(reportRunStatuses),
  trigger: z.enum(reportRunTriggers),
  pdfBytes: z.number().nullable(),
  error: z.string().nullable(),
  emailedAt: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  requestedByName: z.string().nullable(),
});

const runToOut = (r: RunRow): z.input<typeof runOut> => ({
  id: r.id,
  definitionId: r.definitionId,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  status: r.status,
  trigger: r.trigger,
  pdfBytes: r.pdfBytes,
  error: r.error,
  emailedAt: iso(r.emailedAt),
  createdAt: r.createdAt.toISOString(),
  finishedAt: iso(r.finishedAt),
  requestedByName: r.requestedByName,
});

type Shape = Pick<
  DefinitionRow,
  | "scope"
  | "locationIds"
  | "period"
  | "customFrom"
  | "customTo"
  | "schedule"
  | "recipients"
  | "workspaceId"
  | "groupId"
  | "comment"
>;

/** Cross-field rules plus "every listed location is in this workspace". Throws INVALID_INPUT / NOT_FOUND. */
async function validateShape(tx: Tx, orgId: string, s: Shape) {
  if (s.scope === "workspace" && s.locationIds.length > 0) {
    throw new CoreError("INVALID_INPUT", "A workspace report takes no locationIds");
  }
  if (s.scope === "locations") {
    const ids = [...new Set(s.locationIds)];
    if (ids.length === 0) throw new CoreError("INVALID_INPUT", "Pick at least one location");
    const rows = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.orgId, orgId),
          eq(locations.workspaceId, s.workspaceId),
          inArray(locations.id, ids),
        ),
      );
    if (rows.length !== ids.length) throw new AccessError("NOT_FOUND", "Location not found");
  }
  if (s.scope === "group") {
    if (!s.groupId) throw new CoreError("INVALID_INPUT", "A group report needs a groupId");
    if (s.locationIds.length > 0) {
      throw new CoreError("INVALID_INPUT", "A group report takes no locationIds");
    }
    const [g] = await tx
      .select({ id: locationGroups.id })
      .from(locationGroups)
      .where(
        and(
          eq(locationGroups.id, s.groupId),
          eq(locationGroups.orgId, orgId),
          eq(locationGroups.workspaceId, s.workspaceId),
        ),
      );
    if (!g) throw new AccessError("NOT_FOUND", "Location group not found");
  } else if (s.groupId) {
    throw new CoreError("INVALID_INPUT", "Only a group report takes a groupId");
  }
  if (s.comment !== null) {
    const problem = commentProblem(s.comment);
    if (problem) throw new CoreError("INVALID_INPUT", problem);
  }
  if (s.period === "custom") {
    if (!s.customFrom || !s.customTo) {
      throw new CoreError("INVALID_INPUT", "A custom period needs customFrom and customTo");
    }
    if (s.customTo < s.customFrom) {
      throw new CoreError("INVALID_INPUT", "customFrom must not be after customTo");
    }
    if (daysBetween(s.customFrom, s.customTo) > MAX_RANGE_DAYS) {
      throw new CoreError("INVALID_INPUT", `A custom period is at most ${MAX_RANGE_DAYS} days`);
    }
  } else if (s.customFrom || s.customTo) {
    throw new CoreError("INVALID_INPUT", "customFrom/customTo only apply to a custom period");
  }
  if (s.schedule === "monthly" && s.recipients.length === 0) {
    throw new CoreError("INVALID_INPUT", "A monthly schedule needs at least one recipient");
  }
}

async function workspaceInScope(tx: Tx, actor: Actor, workspaceId: string) {
  const scope = workspaceScope(actor);
  const [w] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!w || (scope !== "all" && !scope.includes(w.id))) {
    throw new AccessError("NOT_FOUND", "Workspace not found");
  }
}

/** What an audit row may say about a definition: no recipient addresses, only their count. */
const auditShape = (d: DefinitionRow) => ({
  workspaceId: d.workspaceId,
  name: d.name,
  kind: d.kind,
  scope: d.scope,
  locationCount: d.locationIds.length,
  groupId: d.groupId,
  language: d.language,
  commentLength: d.comment?.length ?? 0,
  aiSummary: d.aiSummary,
  period: d.period,
  schedule: d.schedule,
  recipientCount: d.recipients.length,
});

const recipientsSchema = z.array(z.email().max(254)).max(20);

const definitionFields = {
  name: z.string().trim().min(1).max(120),
  scope: z.enum(reportScopes),
  locationIds: z.array(z.uuid()).max(200),
  groupId: z.uuid().nullable(),
  language: z.enum(reportLanguages),
  /** Raw; normalised and limited to 500 in the handler. 2000 only bounds what is parsed. */
  comment: z.string().max(2000).nullable(),
  /** Opt-in AI summary at the top of each report; off by default. Each one is charged like an AI draft. */
  aiSummary: z.boolean(),
  period: z.enum(reportPeriods),
  customFrom: day.nullable(),
  customTo: day.nullable(),
  schedule: z.enum(reportSchedules),
  recipients: recipientsSchema,
  branding: brandingSchema,
};

export const reportsDefinitionsList = defineAction({
  name: "reports.definitions.list",
  description:
    "List report definitions the caller can see (optionally one workspace): name, scope (whole workspace or chosen locations), period (last_month, last_30_days, custom), monthly email schedule, recipients and branding. Needs report:read.",
  input: z.object({ workspaceId: z.uuid().optional() }),
  output: z.object({ definitions: z.array(definitionOut) }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "report:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const rows = await tx
      .select()
      .from(reportDefinitions)
      .where(
        and(
          eq(reportDefinitions.orgId, actor.orgId),
          input.workspaceId ? eq(reportDefinitions.workspaceId, input.workspaceId) : undefined,
          scope === "all" ? undefined : inArray(reportDefinitions.workspaceId, scope),
        ),
      )
      .orderBy(reportDefinitions.name, reportDefinitions.id);
    return { definitions: rows.map(definitionToOut) };
  },
});

export const reportsDefinitionsCreate = defineAction({
  name: "reports.definitions.create",
  description:
    "Create a report definition for a workspace. scope 'workspace' covers every location in it (locationIds empty); scope 'locations' needs locationIds from that workspace. period: last_month, last_30_days, or custom (customFrom/customTo, YYYY-MM-DD). schedule 'monthly' emails recipients a 30-day link to last month's PDF on the 1st (needs at least one recipient). branding: agencyName and colour (#RRGGBB) shown on the PDF. Reports contain performance numbers and keywords only, never review text. scope 'group' needs groupId (a location group in that workspace; its members are read when each run is generated). language: en (default) or es, for the PDF's labels. comment: optional text for the reader, at most 500 characters, printed last; curly quotes and dashes are normalised and characters the PDF cannot print are refused. aiSummary: false by default; true adds a short plain-language AI summary (written only from the report's own numbers) at the top of each report's PDF, share page and email, and each summary is charged to the account like an AI draft. A report is never failed by it: if AI is off, over its limit or cannot be paid for, the report is made without the summary.  kind: performance (default) or reviews. A reviews report holds review counts, ratings, reply rate and time to reply by location, never review text or reviewer names; kind cannot be changed later. Needs report:manage.",
  input: z.object({
    workspaceId: z.uuid(),
    kind: z.enum(reportKinds).default("performance"),
    ...definitionFields,
    groupId: definitionFields.groupId.default(null),
    language: definitionFields.language.default("en"),
    comment: definitionFields.comment.default(null),
    aiSummary: definitionFields.aiSummary.default(false),
  }),
  output: z.object({ definition: definitionOut }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "report:manage", { workspaceId: input.workspaceId });
    await workspaceInScope(tx, actor, input.workspaceId);
    const comment = normalizeComment(input.comment);
    await validateShape(tx, actor.orgId, { ...input, comment });
    const { branding, ...rest } = input;
    const [d] = await tx
      .insert(reportDefinitions)
      .values({ ...rest, comment, branding, orgId: actor.orgId, createdBy: actor.userId })
      .returning();
    await audit({
      action: "reports.definition_created",
      entityType: "report_definition",
      entityId: d!.id,
      before: null,
      after: auditShape(d!),
    });
    return { definition: definitionToOut(d!) };
  },
});

export const reportsDefinitionsUpdate = defineAction({
  name: "reports.definitions.update",
  description:
    "Change a report definition (send only the fields to change). The same rules as create apply to the result. Needs report:manage.",
  input: z.object(definitionFields).partial().extend({ id: z.uuid() }),
  output: z.object({ definition: definitionOut }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadDefinitionForActor(tx, actor, input.id);
    authorize(actor, "report:manage", { workspaceId: before.workspaceId });
    const next = {
      ...before,
      ...Object.fromEntries(
        Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined),
      ),
    } as DefinitionRow;
    if (input.comment !== undefined) next.comment = normalizeComment(input.comment);
    await validateShape(tx, actor.orgId, next);
    const [d] = await tx
      .update(reportDefinitions)
      .set({
        name: next.name,
        scope: next.scope,
        locationIds: next.locationIds,
        groupId: next.groupId,
        language: next.language,
        comment: next.comment,
        aiSummary: next.aiSummary,
        period: next.period,
        customFrom: next.customFrom,
        customTo: next.customTo,
        schedule: next.schedule,
        recipients: next.recipients,
        branding: next.branding,
        updatedAt: new Date(),
      })
      .where(eq(reportDefinitions.id, before.id))
      .returning();
    await audit({
      action: "reports.definition_updated",
      entityType: "report_definition",
      entityId: before.id,
      before: auditShape(before),
      after: auditShape(d!),
    });
    return { definition: definitionToOut(d!) };
  },
});

export const reportsDefinitionsDelete = defineAction({
  name: "reports.definitions.delete",
  description:
    "Delete a report definition together with its runs and share links (links stop working). Needs report:manage.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadDefinitionForActor(tx, actor, input.id);
    authorize(actor, "report:manage", { workspaceId: before.workspaceId });
    await tx.delete(reportDefinitions).where(eq(reportDefinitions.id, before.id));
    await audit({
      action: "reports.definition_deleted",
      entityType: "report_definition",
      entityId: before.id,
      before: auditShape(before),
      after: null,
    });
    return { id: before.id };
  },
});

export const reportsGenerate = defineAction({
  name: "reports.generate",
  description:
    "Generate the PDF for a report definition now. Asynchronous: records a run for the definition's current period, audits it and queues a worker job in the same transaction; poll reports.runs.get until status is 'done', then use reports.download or reports.share. Needs report:manage.",
  input: z.object({ definitionId: z.uuid() }),
  output: z.object({
    runId: z.string(),
    jobId: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const def = await loadDefinitionForActor(tx, actor, input.definitionId);
    authorize(actor, "report:manage", { workspaceId: def.workspaceId });
    return createManualRun(tx, { def, requestedBy: actor.userId, audit });
  },
});

export const reportsRunsList = defineAction({
  name: "reports.runs.list",
  description:
    "List report runs (newest first), optionally for one definition. Metadata only (period, status, size); use reports.download for the PDF. requestedByName is the person who generated a manual run (null for scheduled runs). Needs report:read.",
  input: z.object({
    definitionId: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: z.object({ runs: z.array(runOut) }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.definitionId) await loadDefinitionForActor(tx, actor, input.definitionId);
    const scope = workspaceScope(actor);
    const rows = await tx
      .select(runColumns)
      .from(reportRuns)
      .innerJoin(reportDefinitions, eq(reportDefinitions.id, reportRuns.definitionId))
      .leftJoin(users, eq(users.id, reportRuns.requestedBy))
      .where(
        and(
          eq(reportRuns.orgId, actor.orgId),
          input.definitionId ? eq(reportRuns.definitionId, input.definitionId) : undefined,
          scope === "all" ? undefined : inArray(reportDefinitions.workspaceId, scope),
        ),
      )
      .orderBy(desc(reportRuns.createdAt), desc(reportRuns.id))
      .limit(input.limit);
    return { runs: rows.map(runToOut) };
  },
});

export const reportsRunsGet = defineAction({
  name: "reports.runs.get",
  description:
    "One report run's metadata plus its share links (id, expiry, revoked or not; never the token). requestedByName is the person who generated a manual run (null for scheduled runs). Needs report:read.",
  input: z.object({ runId: z.uuid() }),
  output: z.object({
    run: runOut,
    shareLinks: z.array(
      z.object({
        id: z.string(),
        expiresAt: z.string(),
        revokedAt: z.string().nullable(),
        createdAt: z.string(),
        active: z.boolean(),
      }),
    ),
  }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const { run } = await loadRunForActor(tx, actor, input.runId);
    const links = await tx
      .select()
      .from(reportShareLinks)
      .where(eq(reportShareLinks.reportRunId, run.id))
      .orderBy(desc(reportShareLinks.createdAt));
    const now = Date.now();
    return {
      run: runToOut(run),
      shareLinks: links.map((l) => ({
        id: l.id,
        expiresAt: l.expiresAt.toISOString(),
        revokedAt: iso(l.revokedAt),
        createdAt: l.createdAt.toISOString(),
        active: !l.revokedAt && l.expiresAt.getTime() > now,
      })),
    };
  },
});

export const reportsDownload = defineAction({
  name: "reports.download",
  description: `Download a finished report as a PDF, base64-encoded (filename, contentType, sizeBytes, base64). Refuses PDFs over ${PERFORMANCE_CONFIG.reportMcpMaxBytes} bytes: use reports.share to get a link instead. Needs report:read.`,
  input: z.object({ runId: z.uuid() }),
  output: z.object({
    filename: z.string(),
    contentType: z.literal("application/pdf"),
    sizeBytes: z.number(),
    base64: z.string(),
  }),
  permission: "report:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const { pdf, filename } = await loadReportPdf(tx, actor, input.runId);
    if (pdf.length > PERFORMANCE_CONFIG.reportMcpMaxBytes) {
      throw new CoreError(
        "INVALID_INPUT",
        `The PDF is ${pdf.length} bytes, over the ${PERFORMANCE_CONFIG.reportMcpMaxBytes} byte limit for this tool. Use reports.share for a link.`,
      );
    }
    return {
      filename,
      contentType: "application/pdf" as const,
      sizeBytes: pdf.length,
      base64: pdf.toString("base64"),
    };
  },
});

export const reportsShare = defineAction({
  name: "reports.share",
  description: `Create a public share link for a finished report: anyone with the URL can download the PDF without logging in until it expires (expiresInDays 1-${PERFORMANCE_CONFIG.shareLinkMaxDays}, default ${PERFORMANCE_CONFIG.shareLinkDefaultDays}) or is revoked. The link shows performance numbers that Google does not show publicly, so create it only if the business has agreed: businessAgreed must be true. Search engines are told not to index it. The URL is returned ONCE and cannot be recovered; only its hash is stored. Every access is audited. An API token cannot apply this: a person approves it in OpenGMB. Needs report:manage.`,
  input: z.object({
    runId: z.uuid(),
    expiresInDays: z.number().int().min(1).max(PERFORMANCE_CONFIG.shareLinkMaxDays).default(PERFORMANCE_CONFIG.shareLinkDefaultDays),
    /** Explicit confirmation that the business has agreed to this public link (legal review Q33c). */
    businessAgreed: z.literal(true),
  }),
  output: z.object({
    linkId: z.string(),
    url: z.string(),
    expiresAt: z.string(),
  }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { run, def } = await loadRunForActor(tx, actor, input.runId);
    authorize(actor, "report:manage", { workspaceId: def.workspaceId });
    if (run.status !== "done") throw new CoreError("CONFLICT", "The report is not ready");
    const link = await createShareLink(tx, {
      orgId: actor.orgId,
      reportRunId: run.id,
      createdBy: actor.userId,
      expiresInDays: input.expiresInDays,
    });
    await audit({
      action: "reports.share_created",
      entityType: "report_share_link",
      entityId: link.linkId,
      before: null,
      after: { runId: run.id, expiresAt: link.expiresAt.toISOString(), businessAgreed: true },
    });
    return {
      linkId: link.linkId,
      url: shareUrl(link.token),
      expiresAt: link.expiresAt.toISOString(),
    };
  },
});

export const reportsShareRevoke = defineAction({
  name: "reports.share.revoke",
  description:
    "Revoke a share link by its id (from reports.runs.get); the URL stops working immediately. Needs report:manage.",
  input: z.object({ linkId: z.uuid() }),
  output: z.object({ linkId: z.string(), revokedAt: z.string() }),
  permission: "report:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [link] = await tx
      .select()
      .from(reportShareLinks)
      .where(and(eq(reportShareLinks.id, input.linkId), eq(reportShareLinks.orgId, actor.orgId)));
    if (!link) throw new AccessError("NOT_FOUND", "Share link not found");
    const { def } = await loadRunForActor(tx, actor, link.reportRunId);
    authorize(actor, "report:manage", { workspaceId: def.workspaceId });
    if (link.revokedAt) throw new CoreError("CONFLICT", "The link is already revoked");
    const revokedAt = new Date();
    await tx.update(reportShareLinks).set({ revokedAt }).where(eq(reportShareLinks.id, link.id));
    await audit({
      action: "reports.share_revoked",
      entityType: "report_share_link",
      entityId: link.id,
      before: { runId: link.reportRunId, revoked: false },
      after: { runId: link.reportRunId, revoked: true },
    });
    return { linkId: link.id, revokedAt: revokedAt.toISOString() };
  },
});
