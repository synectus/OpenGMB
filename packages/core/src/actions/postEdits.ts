import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { locations, postEdits, posts, users, type Tx } from "@opengmb/db";
import { AccessError, workspaceScope, authorize, type Actor } from "../actor";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import { notifyApprovalRequested } from "../approvals";
import { enqueueJob } from "../jobs";
import { roleHasPermission } from "../permissions";
import {
  changedEditFields,
  contentFromRow,
  editShape,
  mergeContent,
  postAuditFields,
  type PostRow,
} from "../posts/content";
import { checkPostAtLocations } from "../posts/context";
import {
  POST_EDIT_QUEUE,
  contentWithEdit,
  editAuditFields,
  editableTargets,
  type PostEditResult,
  type PostEditRow,
} from "../posts/edit";
import { defineAction } from "../registry";
import { guardrailOut, loadPost } from "./posts";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const EDIT_NOT_FOUND = () => new AccessError("NOT_FOUND", "Post edit not found");
const OPEN = ["pending_approval", "applying"] as const;

const editOut = z.object({
  id: z.string(),
  postId: z.string(),
  workspaceId: z.string(),
  /** 1, 2, ... per post. */
  revision: z.number().int(),
  status: z.enum([
    "pending_approval",
    "applying",
    "applied",
    "partly_applied",
    "failed",
    "rejected",
    "cancelled",
  ]),
  /** Google field names the edit changes (the updateMask): summary, callToAction, event, offer, media. */
  changedFields: z.array(z.string()),
  summary: z.string(),
  cta: z.object({ actionType: z.string(), url: z.string().nullish() }).nullable(),
  event: z
    .object({
      title: z.string().nullish(),
      startDate: z.string().nullish(),
      startTime: z.string().nullish(),
      endDate: z.string().nullish(),
      endTime: z.string().nullish(),
    })
    .nullable(),
  offer: z
    .object({
      couponCode: z.string().nullish(),
      redeemOnlineUrl: z.string().nullish(),
      termsConditions: z.string().nullish(),
    })
    .nullable(),
  media: z.array(z.object({ sourceUrl: z.string() })),
  guardrail: guardrailOut.nullable(),
  warningsAcknowledged: z.boolean(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** One row per location once the worker has tried it. error is a reason code, never Google's body. */
  results: z.array(
    z.object({
      targetId: z.string(),
      locationId: z.string(),
      locationName: z.string(),
      status: z.enum(["applied", "failed"]),
      error: z.string().nullable(),
    }),
  ),
  can: z.object({ approve: z.boolean(), reject: z.boolean(), cancel: z.boolean() }),
});

async function toEditOut(tx: Tx, actor: Actor, edit: PostEditRow) {
  const results = edit.results as PostEditResult[];
  const ids = [...new Set(results.map((r) => r.locationId))];
  const names = new Map(
    ids.length
      ? (
          await tx
            .select({ id: locations.id, name: locations.name })
            .from(locations)
            .where(inArray(locations.id, ids))
        ).map((l) => [l.id, l.name])
      : [],
  );
  const [by] = await tx.select({ name: users.name }).from(users).where(eq(users.id, edit.createdBy));
  const pending = edit.status === "pending_approval";
  return {
    id: edit.id,
    postId: edit.postId,
    workspaceId: edit.workspaceId,
    revision: edit.revision,
    status: edit.status,
    changedFields: edit.changedFields,
    summary: edit.summary,
    cta: edit.cta as z.input<typeof editOut>["cta"],
    event: edit.event as z.input<typeof editOut>["event"],
    offer: edit.offer as z.input<typeof editOut>["offer"],
    media: edit.media as { sourceUrl: string }[],
    guardrail: (edit.guardrailResult as GuardrailResult | null) ?? null,
    warningsAcknowledged: edit.warningsAcknowledged,
    createdByName: by?.name ?? null,
    createdAt: edit.createdAt.toISOString(),
    approvedAt: iso(edit.approvedAt),
    rejectedAt: iso(edit.rejectedAt),
    rejectReason: edit.rejectReason,
    appliedAt: iso(edit.appliedAt),
    results: results.map((r) => ({
      targetId: r.targetId,
      locationId: r.locationId,
      locationName: names.get(r.locationId) ?? "",
      status: r.status,
      error: r.error ?? null,
    })),
    can: {
      approve: pending && roleHasPermission(actor.role, "review:approve"),
      reject: pending && roleHasPermission(actor.role, "review:approve"),
      cancel: pending && roleHasPermission(actor.role, "review:draft"),
    },
  } satisfies z.input<typeof editOut>;
}

async function loadEdit(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
): Promise<{ edit: PostEditRow; post: PostRow }> {
  const [edit] = await tx
    .select()
    .from(postEdits)
    .where(and(eq(postEdits.id, id), eq(postEdits.orgId, actor.orgId)))
    .for("update");
  if (!edit) throw EDIT_NOT_FOUND();
  const scope = workspaceScope(actor);
  if (scope !== "all" && !scope.includes(edit.workspaceId)) throw EDIT_NOT_FOUND();
  authorize(actor, permission, { workspaceId: edit.workspaceId });
  const [post] = await tx.select().from(posts).where(eq(posts.id, edit.postId));
  if (!post) throw EDIT_NOT_FOUND();
  return { edit, post };
}

/** pending_approval -> `to`, or CONFLICT if the edit moved on. */
async function leavePending(
  tx: Tx,
  edit: PostEditRow,
  to: PostEditRow["status"],
  set: Partial<typeof postEdits.$inferInsert>,
): Promise<PostEditRow> {
  if (edit.status !== "pending_approval") {
    throw new CoreError("CONFLICT", `Only an edit waiting for approval can be changed (this one is ${edit.status})`);
  }
  const [row] = await tx
    .update(postEdits)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(and(eq(postEdits.id, edit.id), eq(postEdits.status, "pending_approval")))
    .returning();
  if (!row) throw new CoreError("CONFLICT", "The edit changed while it was being updated");
  return row;
}

const proposeOut = z.object({
  /**
   * blocked: a block-severity rule fired, nothing was stored. needs_acknowledgement: only warnings
   * fired and acknowledgeWarnings was not true, nothing was stored. pending_approval: stored.
   */
  outcome: z.enum(["blocked", "needs_acknowledgement", "pending_approval"]),
  code: z.string().nullable(),
  edit: editOut.nullable(),
  result: guardrailOut,
});

export const postsProposeEdit = defineAction({
  name: "posts.proposeEdit",
  description:
    "Propose a change to a post that is already published on Google (post status published). Nothing is sent to Google until a person with approval rights approves it (posts.approveEdit); then the worker patches the live post at each location with Google's localPosts.patch, naming only the changed fields in the updateMask. Send only the fields to change: summary, cta, event, offer, media (a null or empty field is cleared on Google). The topic type and language cannot change; a different type is a new post. The guardrails run now for every location the post is live at (a block-severity violation stores nothing and returns outcome blocked; warnings need acknowledgeWarnings) and again per location right before the patch. One open edit per post. CONFLICT if the post is not published, has no live Google post, or already has an open edit. Posts made on Google outside OpenGMB cannot be edited here. Google writes stay off unless GOOGLE_BUSINESS_WRITES is live: the edit then fails per location with google_writes_disabled.",
  input: z.object({
    id: z.uuid(),
    ...editShape,
    acknowledgeWarnings: z.boolean().optional(),
  }),
  output: proposeOut,
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input): Promise<z.input<typeof proposeOut>> {
    const post = await loadPost(tx, actor, input.id, "review:draft");
    if (post.status !== "published") {
      throw new CoreError(
        "CONFLICT",
        `Only a published post can be edited this way (this post is ${post.status}). Change a draft with posts.updateDraft.`,
      );
    }
    const [open] = await tx
      .select({ id: postEdits.id })
      .from(postEdits)
      .where(and(eq(postEdits.postId, post.id), inArray(postEdits.status, [...OPEN])));
    if (open) throw new CoreError("CONFLICT", "This post already has an edit waiting");
    const targets = await editableTargets(tx, post);
    if (targets.length === 0) {
      throw new CoreError("CONFLICT", "This post has no live Google post to edit");
    }
    const current = contentFromRow(post);
    const next = mergeContent(current, input);
    const changed = changedEditFields(current, next);
    if (changed.length === 0) throw new CoreError("INVALID_INPUT", "Nothing changed");
    const result = await checkPostAtLocations(tx, {
      workspaceId: post.workspaceId,
      locationIds: [...new Set(targets.map((t) => t.locationId))],
      content: next,
    });
    const refused = (action: string) =>
      audit({
        action,
        entityType: "post",
        entityId: post.id,
        before: { status: post.status, occurrence: post.occurrence },
        after: { changedFields: changed, ...postAuditFields({ ...post, ...next }, result) },
      });
    if (!result.ok) {
      await refused("post.edit_blocked");
      return { outcome: "blocked", code: null, edit: null, result };
    }
    const hasWarnings = result.violations.length > 0;
    if (hasWarnings && input.acknowledgeWarnings !== true) {
      await refused("post.edit_acknowledgement_required");
      return {
        outcome: "needs_acknowledgement",
        code: "WARNINGS_REQUIRE_ACKNOWLEDGEMENT",
        edit: null,
        result,
      };
    }
    const [last] = await tx
      .select({ revision: postEdits.revision })
      .from(postEdits)
      .where(eq(postEdits.postId, post.id))
      .orderBy(desc(postEdits.revision))
      .limit(1);
    const [row] = await tx
      .insert(postEdits)
      .values({
        orgId: actor.orgId,
        workspaceId: post.workspaceId,
        postId: post.id,
        revision: (last?.revision ?? 0) + 1,
        createdBy: actor.userId,
        createdSurface: actor.surface,
        summary: next.summary,
        cta: next.cta,
        event: next.event,
        offer: next.offer,
        media: next.media,
        changedFields: changed,
        guardrailResult: result,
        warningsAcknowledged: hasWarnings,
      })
      .returning();
    await audit({
      action: "post.edit_proposed",
      entityType: "post",
      entityId: post.id,
      before: { status: post.status, occurrence: post.occurrence },
      after: {
        editStatus: row!.status,
        warningsAcknowledged: hasWarnings,
        locationCount: targets.length,
        ...editAuditFields(post, row!, result),
      },
    });
    await notifyApprovalRequested(tx, audit, {
      orgId: actor.orgId,
      workspaceId: post.workspaceId,
      type: "postedit",
      id: row!.id,
      submittedAt: row!.createdAt,
    });
    return {
      outcome: "pending_approval",
      code: null,
      edit: await toEditOut(tx, actor, row!),
      result,
    };
  },
});

export const postsApproveEdit = defineAction({
  name: "posts.approveEdit",
  description:
    "Approve a proposed edit of a published post (pending_approval -> applying). This is the step that lets the change reach Google: it queues a worker job that patches the live post at each location, running the guardrails again per location first. Poll posts.editGet for the per-location results. Client approvers can approve edits in their own workspaces only.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ edit: editOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const { edit, post } = await loadEdit(tx, actor, input.id, "review:approve");
    const row = await leavePending(tx, edit, "applying", {
      approvedBy: actor.userId,
      approvedAt: new Date(),
    });
    const jobId = await enqueueJob(tx, POST_EDIT_QUEUE, { editId: row.id });
    await audit({
      action: "post.edit_approved",
      entityType: "post",
      entityId: post.id,
      before: { editStatus: edit.status },
      after: { editStatus: row.status, jobId, ...editAuditFields(post, row) },
    });
    return { edit: await toEditOut(tx, actor, row) };
  },
});

export const postsRejectEdit = defineAction({
  name: "posts.rejectEdit",
  description:
    "Reject a proposed edit of a published post, with the reason shown to the author (pending_approval -> rejected). The live post is untouched; propose a new edit to try again.",
  input: z.object({ id: z.uuid(), reason: z.string().min(1).max(2_000) }),
  output: z.object({ edit: editOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const { edit, post } = await loadEdit(tx, actor, input.id, "review:approve");
    const row = await leavePending(tx, edit, "rejected", {
      rejectedBy: actor.userId,
      rejectedAt: new Date(),
      rejectReason: input.reason,
    });
    await audit({
      action: "post.edit_rejected",
      entityType: "post",
      entityId: post.id,
      before: { editStatus: edit.status },
      after: { editStatus: row.status, reasonLength: input.reason.length, ...editAuditFields(post, row) },
    });
    return { edit: await toEditOut(tx, actor, row) };
  },
});

export const postsCancelEdit = defineAction({
  name: "posts.cancelEdit",
  description:
    "Withdraw a proposed edit that is still waiting for approval (pending_approval -> cancelled). The live post is untouched.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ edit: editOut }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const { edit, post } = await loadEdit(tx, actor, input.id, "review:draft");
    const row = await leavePending(tx, edit, "cancelled", {
      cancelledBy: actor.userId,
      cancelledAt: new Date(),
    });
    await audit({
      action: "post.edit_cancelled",
      entityType: "post",
      entityId: post.id,
      before: { editStatus: edit.status },
      after: { editStatus: row.status, ...editAuditFields(post, row) },
    });
    return { edit: await toEditOut(tx, actor, row) };
  },
});

export const postsEditGet = defineAction({
  name: "posts.editGet",
  description:
    "The latest proposed edit of a published post (any status), with the per-location results once it was approved, and whether the caller may propose a new one (canPropose: the post is published, has a live Google post and no open edit, and the caller may draft).",
  input: z.object({ id: z.uuid() }),
  output: z.object({ edit: editOut.nullable(), canPropose: z.boolean() }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const post = await loadPost(tx, actor, input.id, "review:read", false);
    const [edit] = await tx
      .select()
      .from(postEdits)
      .where(eq(postEdits.postId, post.id))
      .orderBy(desc(postEdits.revision))
      .limit(1);
    const open = edit && (OPEN as readonly string[]).includes(edit.status);
    const canPropose =
      post.status === "published" &&
      !open &&
      roleHasPermission(actor.role, "review:draft") &&
      (await editableTargets(tx, post)).length > 0;
    return { edit: edit ? await toEditOut(tx, actor, edit) : null, canPropose };
  },
});

// contentWithEdit is re-exported for tests and the web preview.
export { contentWithEdit };
