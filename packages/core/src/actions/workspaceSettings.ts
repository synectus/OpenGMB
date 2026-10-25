import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { users, workspaceReplySettings, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { autoApproveAllowed } from "../review-requests/identity";
import {
  applyProfileDefaults,
  getWorkspaceReplySettings,
  OPTIONAL_PACKS,
  type WorkspaceReplySettings,
} from "../reviews/workspace-settings";

const profileSchema = z.enum(["general", "healthcare", "legal"]);

const settingsOut = z.object({
  workspaceId: z.string(),
  profile: profileSchema,
  packs: z.array(z.enum(OPTIONAL_PACKS)),
  skipPositiveReviews: z.boolean(),
  genericTemplatesOnly: z.boolean(),
  staffNames: z.array(z.string()),
  autoApproveMinStars: z.union([z.literal(4), z.literal(5), z.null()]),
  autoPublish: z.boolean(),
  h2Severity: z.enum(["block", "warn"]),
  draftOnArrival: z.boolean(),
  /** Who switched automatic approval on and when (ISO). Null while it is off, and for rules set before this was recorded. */
  autoApproveEnabledBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  autoApproveEnabledAt: z.string().nullable(),
  /** True for a HIPAA covered entity: auto-approve and auto-publish are locked off. */
  autoApproveLocked: z.boolean(),
});

type AutoMeta = Pick<z.input<typeof settingsOut>, "autoApproveEnabledBy" | "autoApproveEnabledAt">;

async function loadAutoMeta(tx: Tx, workspaceId: string): Promise<AutoMeta> {
  const [row] = await tx
    .select({ userId: workspaceReplySettings.autoApproveEnabledBy, at: workspaceReplySettings.autoApproveEnabledAt, name: users.name })
    .from(workspaceReplySettings)
    .leftJoin(users, eq(users.id, workspaceReplySettings.autoApproveEnabledBy))
    .where(eq(workspaceReplySettings.workspaceId, workspaceId));
  return {
    autoApproveEnabledBy: row?.userId ? { userId: row.userId, name: row.name ?? "" } : null,
    autoApproveEnabledAt: row?.at ? row.at.toISOString() : null,
  };
}

function toOut(workspaceId: string, s: WorkspaceReplySettings, locked: boolean, meta: AutoMeta): z.input<typeof settingsOut> {
  return {
    ...meta,
    workspaceId,
    profile: s.profile,
    // universal is implicit and never stored
    packs: s.packs.filter((p): p is (typeof OPTIONAL_PACKS)[number] => p !== "universal"),
    skipPositiveReviews: s.skipPositiveReviews,
    genericTemplatesOnly: s.genericTemplatesOnly,
    staffNames: s.staffNames,
    autoApproveMinStars: s.autoApproveMinStars,
    autoPublish: s.autoPublish,
    h2Severity: s.h2Severity,
    draftOnArrival: s.draftOnArrival,
    autoApproveLocked: locked,
  };
}

/** Throws for an unknown workspace; returns whether auto-approve is allowed for it (false for a HIPAA covered entity). */
async function requireWorkspace(tx: Tx, actor: Actor, workspaceId: string): Promise<{ autoApproveAllowed: boolean }> {
  const [w] = await tx
    .select({ id: workspaces.id, hipaaCoveredEntity: workspaces.hipaaCoveredEntity })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
  return { autoApproveAllowed: autoApproveAllowed(w) };
}

export const workspaceSettingsGet = defineAction({
  name: "workspaceSettings.get",
  description:
    "Get a workspace's reply settings: profile (general, healthcare, legal), guardrail packs, whether positive (4-5 star) reviews are skipped, generic-templates-only, staff names (used by the H2.staff guardrail) and approval rules (autoApproveMinStars 4, 5 or null; autoPublish; autoApproveEnabledBy and autoApproveEnabledAt say who turned the rule on and when, null while off) and h2Severity (block or warn: whether the HIPAA H2.* rules block or only warn) and draftOnArrival (whether a new review found by the sync automatically gets an AI reply draft) and autoApproveLocked (true for a HIPAA covered entity, set with workspaces.setHipaa: auto-approve and auto-publish read as off and cannot be turned on). A workspace that was never configured returns the defaults. 1-3 star replies are always manual and never auto-published.",
  input: z.object({ workspaceId: z.uuid() }),
  output: settingsOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const ws = await requireWorkspace(tx, actor, input.workspaceId);
    return toOut(input.workspaceId, await getWorkspaceReplySettings(tx, input.workspaceId), !ws.autoApproveAllowed, await loadAutoMeta(tx, input.workspaceId));
  },
});

export const workspaceSettingsUpdate = defineAction({
  name: "workspaceSettings.update",
  description:
    "Update a workspace's reply settings; only the fields you pass change. Changing profile first applies that profile's defaults (healthcare: hipaa pack on, skipPositiveReviews on, generic templates only; legal: legal_ethics pack on; general: none), then the other fields in the same call override them. packs may contain hipaa and legal_ethics (universal always runs); the profile's required pack cannot be removed. staffNames: up to 200 names of 2-80 characters. autoApproveMinStars: 4, 5 or null (off); autoPublish: publish automatically once approved. Turning automatic approval on is the client's express consent for OpenGMB to publish those replies, so it is per workspace, off by default, and the settings record who turned it on and when (autoApproveEnabledBy, autoApproveEnabledAt). An API token cannot apply this change: a person approves it in OpenGMB. h2Severity: block (default) or warn, for all HIPAA H2.* rules together (reviewer/provider/staff names, clinical terms, dates, echoed review text); only has an effect while the hipaa pack is on, and warnings still need acknowledgeWarnings. draftOnArrival: draft an AI reply automatically for each new review the sync finds (off by default; the draft goes through the same approval rules as a manual one; counts as AI use; the drafts are made as the person who switched it on). 1-3 star replies are always manual and never auto-published. Needs review:configure (owner, admin).",
  input: z.object({
    workspaceId: z.uuid(),
    profile: profileSchema.optional(),
    packs: z.array(z.enum(OPTIONAL_PACKS)).max(OPTIONAL_PACKS.length).optional(),
    skipPositiveReviews: z.boolean().optional(),
    staffNames: z.array(z.string().trim().min(2).max(80)).max(200).optional(),
    autoApproveMinStars: z.union([z.literal(4), z.literal(5), z.null()]).optional(),
    autoPublish: z.boolean().optional(),
    h2Severity: z.enum(["block", "warn"]).optional(),
    draftOnArrival: z.boolean().optional(),
  }),
  output: settingsOut,
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    const ws = await requireWorkspace(tx, actor, input.workspaceId);
    if (!ws.autoApproveAllowed && (input.autoApproveMinStars != null || input.autoPublish === true)) {
      throw new CoreError("INVALID_INPUT", "Auto-approve is locked off because this client is a HIPAA covered entity. Every reply needs a person to approve it.");
    }
    const before = await getWorkspaceReplySettings(tx, input.workspaceId);

    let next: WorkspaceReplySettings = { ...before };
    if (input.profile !== undefined && input.profile !== before.profile) {
      next = { ...next, ...applyProfileDefaults(input.profile) };
    }
    if (input.packs !== undefined) next.packs = input.packs;
    if (input.skipPositiveReviews !== undefined) {
      next.skipPositiveReviews = input.skipPositiveReviews;
    }
    if (input.staffNames !== undefined) next.staffNames = [...new Set(input.staffNames)];
    if (input.autoApproveMinStars !== undefined) {
      next.autoApproveMinStars = input.autoApproveMinStars;
    }
    if (input.autoPublish !== undefined) next.autoPublish = input.autoPublish;
    if (input.h2Severity !== undefined) next.h2Severity = input.h2Severity;
    if (input.draftOnArrival !== undefined) next.draftOnArrival = input.draftOnArrival;
    // Q15: automatic approval is an explicit, per-workspace, logged choice. Turning it on records who
    // and when; turning it off clears them. An already-on rule keeps its original record.
    const autoWasOn = before.autoApproveMinStars !== null;
    const autoIsOn = next.autoApproveMinStars !== null;
    // The profile's own pack is not optional; keep canonical order.
    const packs = new Set([...next.packs, ...applyProfileDefaults(next.profile).packs]);
    next.packs = OPTIONAL_PACKS.filter((p) => packs.has(p));

    const values = {
      profile: next.profile,
      packs: next.packs,
      skipPositiveReviews: next.skipPositiveReviews,
      genericTemplatesOnly: next.genericTemplatesOnly,
      staffNames: next.staffNames,
      autoApproveMinStars: next.autoApproveMinStars,
      autoPublish: next.autoPublish,
      h2Severity: next.h2Severity,
      draftOnArrival: next.draftOnArrival,
      // The job acts as whoever switched it on; switching it off clears them. Unchanged otherwise.
      ...(next.draftOnArrival !== before.draftOnArrival
        ? { draftOnArrivalBy: next.draftOnArrival ? actor.userId : null }
        : {}),
      ...(autoIsOn !== autoWasOn
        ? {
            autoApproveEnabledBy: autoIsOn ? actor.userId : null,
            autoApproveEnabledAt: autoIsOn ? new Date() : null,
          }
        : {}),
      updatedAt: new Date(),
      updatedBy: actor.userId,
    };
    await tx
      .insert(workspaceReplySettings)
      .values({ workspaceId: input.workspaceId, orgId: actor.orgId, ...values })
      .onConflictDoUpdate({ target: workspaceReplySettings.workspaceId, set: values });
    await audit({
      action: "workspace_settings.update",
      entityType: "workspace_reply_settings",
      entityId: input.workspaceId,
      before,
      after: next,
    });
    return toOut(input.workspaceId, next, !ws.autoApproveAllowed, await loadAutoMeta(tx, input.workspaceId));
  },
});
