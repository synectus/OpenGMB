import { eq } from "drizzle-orm";
import { workspaceReplySettings, workspaces, type Tx } from "@opengmb/db";
import type { PackId } from "../guardrails";
import { autoApproveAllowed } from "../review-requests/identity";

/**
 * Per-workspace reply settings read by the reply flow (R2). The reply flow must read settings
 * only through `getWorkspaceReplySettings` and decide approval only through `decideApproval`.
 */
export type WorkspaceReplySettings = {
  profile: "general" | "healthcare" | "legal";
  packs: PackId[];
  skipPositiveReviews: boolean;
  genericTemplatesOnly: boolean;
  staffNames: string[];
  /** R4: 4 or 5 auto-approves replies to reviews rated at least this; null = always manual. */
  autoApproveMinStars: 4 | 5 | null;
  /** R4: publish automatically once approved. Default false ("never auto-publish"). */
  autoPublish: boolean;
  /**
   * HIPAA H2.* rules (reviewer/provider/staff names, clinical terms, dates, echoed review text)
   * switch together: `block` (default) or `warn`. Warn still needs explicit acknowledgement.
   * Only meaningful while the hipaa pack is on.
   */
  h2Severity: "block" | "warn";
  /** A2: draft an AI reply when the review sync finds a new review. Off by default. */
  draftOnArrival: boolean;
};

export type ReplyProfile = WorkspaceReplySettings["profile"];

/** Packs a workspace can turn on. `universal` is implicit (the engine always runs it) and never stored. */
export const OPTIONAL_PACKS = ["hipaa", "legal_ethics"] as const satisfies readonly PackId[];
export type OptionalPackId = (typeof OPTIONAL_PACKS)[number];

export const DEFAULT_WORKSPACE_REPLY_SETTINGS: WorkspaceReplySettings = {
  profile: "general",
  packs: [],
  skipPositiveReviews: false,
  genericTemplatesOnly: false,
  staffNames: [],
  autoApproveMinStars: null,
  autoPublish: false,
  h2Severity: "block",
  draftOnArrival: false,
};

type ProfileDefaults = Pick<
  WorkspaceReplySettings,
  "profile" | "packs" | "skipPositiveReviews" | "genericTemplatesOnly"
>;

/**
 * G4: what choosing a profile turns on. Healthcare: `hipaa`, no replies to 4-5 star reviews, generic
 * templates only. Legal: `legal_ethics`. General: nothing extra. These are starting values; an
 * owner/admin may change skipPositiveReviews or packs afterwards and the explicit value persists.
 */
export function applyProfileDefaults(profile: ReplyProfile): ProfileDefaults {
  switch (profile) {
    case "healthcare":
      return {
        profile,
        packs: ["hipaa"],
        skipPositiveReviews: true,
        genericTemplatesOnly: true,
      };
    case "legal":
      return {
        profile,
        packs: ["legal_ethics"],
        skipPositiveReviews: false,
        genericTemplatesOnly: false,
      };
    case "general":
      return { profile, packs: [], skipPositiveReviews: false, genericTemplatesOnly: false };
  }
}

type Row = typeof workspaceReplySettings.$inferSelect;

export function settingsFromRow(row: Row): WorkspaceReplySettings {
  return {
    profile: row.profile,
    packs: row.packs as PackId[],
    skipPositiveReviews: row.skipPositiveReviews,
    genericTemplatesOnly: row.genericTemplatesOnly,
    staffNames: row.staffNames,
    autoApproveMinStars: row.autoApproveMinStars as 4 | 5 | null,
    autoPublish: row.autoPublish,
    h2Severity: row.h2Severity,
    draftOnArrival: row.draftOnArrival,
  };
}

/**
 * A workspace without a settings row gets the defaults. The caller has already authorized the workspace.
 * Legal batch B (Q38): for a HIPAA covered entity auto-approve and auto-publish read as off whatever is
 * stored, so no reply path can approve automatically.
 */
export async function getWorkspaceReplySettings(
  tx: Tx,
  workspaceId: string,
): Promise<WorkspaceReplySettings> {
  const [row] = await tx
    .select()
    .from(workspaceReplySettings)
    .where(eq(workspaceReplySettings.workspaceId, workspaceId));
  const settings = row ? settingsFromRow(row) : { ...DEFAULT_WORKSPACE_REPLY_SETTINGS };
  if (settings.autoApproveMinStars === null && !settings.autoPublish) return settings;
  const [w] = await tx.select({ hipaa: workspaces.hipaaCoveredEntity }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return autoApproveAllowed({ hipaaCoveredEntity: w?.hipaa ?? false })
    ? settings
    : { ...settings, autoApproveMinStars: null, autoPublish: false };
}

export type ApprovalDecision = { autoApprove: boolean; autoPublish: boolean };

/** 1–3★ and unrated reviews are always manual and never auto-published (hard rule, not configurable). */
export function decideApproval(
  settings: WorkspaceReplySettings,
  rating: number | null,
): ApprovalDecision {
  if (rating === null || rating <= 3) return { autoApprove: false, autoPublish: false };
  const autoApprove =
    settings.autoApproveMinStars !== null && rating >= settings.autoApproveMinStars;
  return { autoApprove, autoPublish: autoApprove && settings.autoPublish };
}
