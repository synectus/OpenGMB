import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, reviewReplies, reviews, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { notifyApprovalRequested } from "../approvals";
import { CoreError } from "../errors";
import { runGuardrails, type GuardrailResult } from "../guardrails";
import { enqueueJob } from "../jobs";
import { roleHasPermission } from "../permissions";
import { guardrailPreview } from "./previewUtil";
import { defineAction, type ActionContext } from "../registry";
import { decodeCursor, encodeCursor, getReviewRow, type ReviewRow } from "../reviews/queries";
import { buildGuardrailContext } from "../reviews/reply-context";
import { REPLY_DELETE_QUEUE, REPLY_PUBLISH_QUEUE } from "../reviews/reply-jobs";
import {
  OPEN_STATUSES,
  replyAuditFields,
  replyCapabilities,
  transitionReply,
  type ReplyRow,
} from "../reviews/reply-state";
import { decideApproval } from "../reviews/workspace-settings";

const body = z.string().min(1).max(20_000);

const violationOut = z.object({
  ruleId: z.string(),
  packId: z.string(),
  severity: z.enum(["block", "warn"]),
  /** `pending_counsel_review` rules run and report; the status says so. */
  status: z.enum(["active", "pending_counsel_review"]),
  message: z.string(),
  matches: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
});
const guardrailOut = z.object({
  ok: z.boolean(),
  violations: z.array(violationOut),
  packs: z.array(z.string()),
});

const replyOut = z.object({
  id: z.string(),
  reviewId: z.string(),
  workspaceId: z.string(),
  revision: z.number().int(),
  body: z.string(),
  status: z.enum([
    "draft",
    "pending_approval",
    "approved",
    "published",
    "failed",
    "blocked",
    "deleted",
    "superseded",
    "conflict",
  ]),
  createdBy: z.string(),
  createdSurface: z.string(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  publishRequestedAt: z.string().nullable(),
  /** A publish is queued (status approved and requested): poll until it becomes published/failed/blocked. */
  publishPending: z.boolean(),
  publishedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  /**
   * Set when status is conflict: someone changed the reply on Google after this draft was written,
   * so nothing was published. conflictGoogleComment is Google's reply at publish time (null = it was
   * deleted there); open a new revision to resolve.
   */
  conflictGoogleComment: z.string().nullable(),
  conflictGoogleUpdateTime: z.string().nullable(),
  conflictDetectedAt: z.string().nullable(),
  guardrail: guardrailOut.nullable(),
  warningsAcknowledged: z.boolean(),
  /** Set when the workspace star rule approved it (not a person): the rule's minimum stars at that time, e.g. 5. Null otherwise. */
  autoApprovedMinStars: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the caller may do with this reply now; the UI shows buttons from these, not from roles. */
  can: z.object({
    edit: z.boolean(),
    submit: z.boolean(),
    approve: z.boolean(),
    reject: z.boolean(),
    publish: z.boolean(),
  }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toReplyOut(actor: Actor, r: ReplyRow): z.input<typeof replyOut> {
  const c = replyCapabilities(actor, r.status);
  return {
    id: r.id,
    reviewId: r.reviewId,
    workspaceId: r.workspaceId,
    revision: r.revision,
    body: r.body,
    status: r.status,
    createdBy: r.createdBy,
    createdSurface: r.createdSurface,
    submittedAt: iso(r.submittedAt),
    approvedAt: iso(r.approvedAt),
    rejectedAt: iso(r.rejectedAt),
    rejectReason: r.rejectReason,
    publishRequestedAt: iso(r.publishRequestedAt),
    publishPending: r.status === "approved" && r.publishRequestedAt !== null,
    publishedAt: iso(r.publishedAt),
    failureReason: r.failureReason,
    conflictGoogleComment: r.conflictGoogleComment,
    conflictGoogleUpdateTime: iso(r.conflictGoogleUpdateTime),
    conflictDetectedAt: iso(r.conflictDetectedAt),
    guardrail: (r.guardrailResult as GuardrailResult | null) ?? null,
    warningsAcknowledged: r.warningsAcknowledged,
    autoApprovedMinStars: r.autoApprovedMinStars,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    can: {
      edit: c.canEdit,
      submit: c.canSubmit,
      approve: c.canApprove,
      reject: c.canReject,
      publish: c.canPublish,
    },
  };
}

const NOT_FOUND = () => new AccessError("NOT_FOUND", "Reply not found");

/**
 * A reply the actor can see: same org, review in the actor's workspaces at an ACTIVE location,
 * otherwise NOT_FOUND (it does not reveal that the id exists). `lock` takes a row lock so two
 * transitions on one reply serialise.
 */
async function loadReply(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
  lock = true,
): Promise<{ reply: ReplyRow; review: ReviewRow }> {
  const q = tx
    .select()
    .from(reviewReplies)
    .where(and(eq(reviewReplies.id, id), eq(reviewReplies.orgId, actor.orgId)));
  const [reply] = lock ? await q.for("update") : await q;
  if (!reply) throw NOT_FOUND();
  const review = await getReviewRow(tx, actor, reply.reviewId);
  if (!review) throw NOT_FOUND();
  authorize(actor, permission, { workspaceId: reply.workspaceId });
  return { reply, review };
}

async function loadReview(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
) {
  const review = await getReviewRow(tx, actor, id);
  if (!review) throw new AccessError("NOT_FOUND", "Review not found");
  authorize(actor, permission, { workspaceId: review.workspaceId });
  return review;
}

async function openRevision(tx: Tx, reviewId: string) {
  const [open] = await tx
    .select()
    .from(reviewReplies)
    .where(and(eq(reviewReplies.reviewId, reviewId), inArray(reviewReplies.status, OPEN_STATUSES)));
  return open ?? null;
}

/** Queue the publish job inside the action's transaction: it exists if and only if this commits. */
async function requestPublish(
  { tx, actor, audit }: ActionContext,
  reply: ReplyRow,
  extra: Record<string, unknown> = {},
) {
  const jobId = await enqueueJob(tx, REPLY_PUBLISH_QUEUE, { replyId: reply.id });
  await audit({
    action: "review_reply.publish_requested",
    entityType: "review_reply",
    entityId: reply.id,
    before: { status: reply.status, revision: reply.revision },
    after: {
      status: reply.status,
      ...replyAuditFields(reply),
      requestedBy: actor.userId,
      jobId,
      ...extra,
    },
  });
}

export const reviewRepliesCheck = defineAction({
  name: "reviewReplies.check",
  description:
    "Dry-run the reply guardrails for a candidate reply to a review. Writes nothing and stores nothing. Returns { ok, violations, packs }: ok is false when any violation has severity block (blocks cannot be overridden); warn violations need acknowledgeWarnings on submit/publish. Each violation has ruleId, packId, severity, status (active or pending_counsel_review), message and match offsets into the reply. Use it to check an AI-drafted reply before reviewReplies.createDraft.",
  input: z.object({ reviewId: z.uuid(), body: z.string().max(20_000) }),
  output: guardrailOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    await loadReview(tx, actor, input.reviewId, "review:read");
    const built = await buildGuardrailContext(tx, { reviewId: input.reviewId, body: input.body });
    if (!built) throw new AccessError("NOT_FOUND", "Review not found");
    return runGuardrails(built.ctx);
  },
});

export const reviewRepliesCreateDraft = defineAction({
  name: "reviewReplies.createDraft",
  description:
    "Create a draft reply to a review. A review has at most one open revision (draft, pending_approval, approved, blocked or failed): if one exists this is CONFLICT and the message names its id (use reviewReplies.updateDraft). If the review already has a Google reply this opens a new revision that, once published, replaces it. The draft remembers Google's reply as it is now: if someone changes that reply on Google before publishing, the publish is refused with status conflict (nothing is written to Google) and you open a new revision from Google's current reply. The draft is not sent anywhere: call reviewReplies.submit, which runs the guardrails.",
  input: z.object({ reviewId: z.uuid(), body }),
  output: z.object({ reply: replyOut }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview({ read }, input) {
    const result = (await read("reviewReplies.check", {
      reviewId: input.reviewId,
      body: input.body,
    })) as GuardrailResult;
    return guardrailPreview("Draft reply", result, { after: { body: input.body } });
  },
  async handler({ tx, actor, audit }, input) {
    const review = await loadReview(tx, actor, input.reviewId, "review:draft");
    const existing = await openRevision(tx, review.id);
    if (existing) {
      throw new CoreError(
        "CONFLICT",
        `Review already has an open reply revision (${existing.id}, ${existing.status})`,
      );
    }
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${reviewReplies.revision}), 0) + 1` })
      .from(reviewReplies)
      .where(eq(reviewReplies.reviewId, review.id))) as [{ next: number }];
    const [row] = await tx
      .insert(reviewReplies)
      .values({
        orgId: actor.orgId,
        workspaceId: review.workspaceId,
        reviewId: review.id,
        revision: Number(next),
        body: input.body,
        // Google's reply as we know it now; the publish job refuses to overwrite a different one.
        baseReplyComment: review.replyComment,
        baseReplyUpdateTime: review.replyUpdateTime,
        createdBy: actor.userId,
        createdSurface: actor.surface,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new CoreError("CONFLICT", "Review already has an open reply revision");
    await audit({
      action: "review_reply.draft_created",
      entityType: "review_reply",
      entityId: row.id,
      before: null,
      after: {
        status: "draft",
        ...replyAuditFields(row),
        editsPublished: review.replyComment !== null,
      },
    });
    return { reply: toReplyOut(actor, row) };
  },
});

export const reviewRepliesUpdateDraft = defineAction({
  name: "reviewReplies.updateDraft",
  description:
    "Replace the text of a reply that is a draft or blocked (a blocked reply goes back to draft, with its guardrail result cleared). Replies that are pending approval, approved, failed or published cannot be edited: reject it, or open a new revision for a published one.",
  input: z.object({ id: z.uuid(), body }),
  output: z.object({ reply: replyOut }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview({ read, readTx, actor }, input) {
    const [row] = await readTx((tx) =>
      tx
        .select({ reviewId: reviewReplies.reviewId, body: reviewReplies.body })
        .from(reviewReplies)
        .where(and(eq(reviewReplies.id, input.id), eq(reviewReplies.orgId, actor.orgId))),
    );
    if (!row) throw new AccessError("NOT_FOUND", "Reply not found");
    const result = (await read("reviewReplies.check", {
      reviewId: row.reviewId,
      body: input.body,
    })) as GuardrailResult;
    return guardrailPreview("Updated draft reply", result, {
      before: { body: row.body },
      after: { body: input.body },
    });
  },
  async handler({ tx, actor, audit }, input) {
    const { reply } = await loadReply(tx, actor, input.id, "review:draft");
    if (reply.status !== "draft" && reply.status !== "blocked") {
      throw new CoreError("CONFLICT", `A ${reply.status} reply cannot be edited`);
    }
    const set = {
      body: input.body,
      guardrailResult: null,
      warningsAcknowledged: false,
      publishRequestedBy: null,
      publishRequestedAt: null,
      updatedAt: new Date(),
    };
    let row: ReplyRow;
    if (reply.status === "blocked") {
      row = await transitionReply(tx, {
        reply,
        to: "draft",
        action: "draft_updated",
        set,
        audit,
        extra: { previousBodySha256: replyAuditFields(reply).bodySha256 },
      });
    } else {
      [row] = (await tx
        .update(reviewReplies)
        .set(set)
        .where(eq(reviewReplies.id, reply.id))
        .returning()) as [ReplyRow];
      await audit({
        action: "review_reply.draft_updated",
        entityType: "review_reply",
        entityId: row.id,
        before: { status: "draft", revision: row.revision },
        after: {
          status: "draft",
          ...replyAuditFields(row),
          previousBodySha256: replyAuditFields(reply).bodySha256,
        },
      });
    }
    return { reply: toReplyOut(actor, row) };
  },
});

const submitOut = z.object({
  /**
   * blocked: a block-severity rule fired (status blocked, edit to fix). needs_acknowledgement: only
   * warnings fired and acknowledgeWarnings was not true; the reply stays draft, nothing was
   * submitted (code WARNINGS_REQUIRE_ACKNOWLEDGEMENT). pending_approval / approved: submitted.
   */
  outcome: z.enum(["blocked", "needs_acknowledgement", "pending_approval", "approved"]),
  code: z.string().nullable(),
  reply: replyOut,
  result: guardrailOut,
  /** True when the workspace's auto-publish rule queued a publish job. */
  publishQueued: z.boolean(),
});

export const reviewRepliesSubmit = defineAction({
  name: "reviewReplies.submit",
  description:
    "Submit a draft reply: runs the guardrails. Any block-severity violation sets status blocked and returns the violations (not an error). Warnings only: the reply stays a draft and the result has outcome needs_acknowledgement and code WARNINGS_REQUIRE_ACKNOWLEDGEMENT; call again with acknowledgeWarnings true to proceed. Otherwise the workspace approval rule decides: approved (auto-approve; never for 1-3 star reviews) or pending_approval; if the workspace also auto-publishes, a publish job is queued. Guardrails run again just before anything is sent to Google.",
  input: z.object({ id: z.uuid(), acknowledgeWarnings: z.boolean().optional() }),
  output: submitOut,
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler(ctx, input): Promise<z.input<typeof submitOut>> {
    const { tx, actor, audit } = ctx;
    const { reply } = await loadReply(tx, actor, input.id, "review:draft");
    if (reply.status !== "draft") {
      throw new CoreError(
        "CONFLICT",
        `Only a draft can be submitted (this reply is ${reply.status})`,
      );
    }
    const built = await buildGuardrailContext(tx, { reviewId: reply.reviewId, body: reply.body });
    if (!built) throw new AccessError("NOT_FOUND", "Review not found");
    const result = runGuardrails(built.ctx);
    const now = new Date();

    if (!result.ok) {
      const row = await transitionReply(tx, {
        reply,
        to: "blocked",
        action: "blocked",
        set: { guardrailResult: result, warningsAcknowledged: false },
        audit,
        guardrail: result,
        extra: { stage: "submit" },
      });
      return {
        outcome: "blocked",
        code: null,
        reply: toReplyOut(actor, row),
        result,
        publishQueued: false,
      };
    }

    const hasWarnings = result.violations.length > 0;
    if (hasWarnings && input.acknowledgeWarnings !== true) {
      const [row] = (await tx
        .update(reviewReplies)
        .set({ guardrailResult: result, updatedAt: now })
        .where(eq(reviewReplies.id, reply.id))
        .returning()) as [ReplyRow];
      await audit({
        action: "review_reply.acknowledgement_required",
        entityType: "review_reply",
        entityId: row.id,
        before: { status: "draft", revision: row.revision },
        after: { status: "draft", ...replyAuditFields(row, result) },
      });
      return {
        outcome: "needs_acknowledgement",
        code: "WARNINGS_REQUIRE_ACKNOWLEDGEMENT",
        reply: toReplyOut(actor, row),
        result,
        publishQueued: false,
      };
    }

    const decision = decideApproval(built.settings, built.ctx.review.rating);
    const to = decision.autoApprove ? ("approved" as const) : ("pending_approval" as const);
    const publishNow = decision.autoApprove && decision.autoPublish;
    const row = await transitionReply(tx, {
      reply,
      to,
      action: decision.autoApprove ? "auto_approved" : "submitted",
      set: {
        guardrailResult: result,
        warningsAcknowledged: hasWarnings,
        submittedBy: actor.userId,
        submittedAt: now,
        // The rule's number at this moment, or null: a resubmit by hand clears an old value.
        autoApprovedMinStars: decision.autoApprove ? built.settings.autoApproveMinStars : null,
        ...(decision.autoApprove ? { approvedAt: now } : {}),
        ...(publishNow ? { publishRequestedBy: actor.userId, publishRequestedAt: now } : {}),
      },
      audit,
      guardrail: result,
      extra: {
        autoApprove: decision.autoApprove,
        autoPublish: publishNow,
        warningsAcknowledged: hasWarnings,
      },
    });
    if (publishNow) await requestPublish(ctx, row, { trigger: "auto_publish" });
    if (to === "pending_approval") {
      await notifyApprovalRequested(tx, audit, {
        orgId: actor.orgId,
        workspaceId: row.workspaceId,
        type: "reply",
        id: row.id,
        submittedAt: row.submittedAt ?? now,
      });
    }
    return {
      outcome: to,
      code: null,
      reply: toReplyOut(actor, row),
      result,
      publishQueued: publishNow,
    };
  },
});

export const reviewRepliesApprove = defineAction({
  name: "reviewReplies.approve",
  description:
    "Approve a reply that is pending approval (pending_approval -> approved). Approving does not publish: call reviewReplies.publish. Client approvers can approve replies in their own workspaces only.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ reply: replyOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const { reply } = await loadReply(tx, actor, input.id, "review:approve");
    const row = await transitionReply(tx, {
      reply,
      to: "approved",
      action: "approved",
      set: { approvedBy: actor.userId, approvedAt: new Date(), autoApprovedMinStars: null },
      audit,
    });
    return { reply: toReplyOut(actor, row) };
  },
});

export const reviewRepliesReject = defineAction({
  name: "reviewReplies.reject",
  description:
    "Reject a reply that is pending approval: it goes back to draft with the reason shown to the author (pending_approval -> draft). The author edits and resubmits.",
  input: z.object({ id: z.uuid(), reason: z.string().min(1).max(2_000) }),
  output: z.object({ reply: replyOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const { reply } = await loadReply(tx, actor, input.id, "review:approve");
    const row = await transitionReply(tx, {
      reply,
      to: "draft",
      action: "rejected",
      set: {
        rejectedBy: actor.userId,
        rejectedAt: new Date(),
        rejectReason: input.reason,
        warningsAcknowledged: false,
      },
      audit,
      extra: { reasonLength: input.reason.length },
    });
    return { reply: toReplyOut(actor, row) };
  },
});

export const reviewRepliesPublish = defineAction({
  name: "reviewReplies.publish",
  description:
    "Queue publishing of an approved (or failed) reply to Google. Asynchronous and does not call Google: it records the request, audits it and queues a worker job in the same transaction, returning { queued: true }. The worker runs the guardrails again and then sends the reply; poll reviewReplies.list until the status is published, failed (failureReason), blocked or conflict (someone changed the reply on Google after the draft; nothing was written, open a new revision). acknowledgeWarnings true accepts warn-severity violations that appear at publish time. A failed reply is retried by calling this again.",
  input: z.object({ id: z.uuid(), acknowledgeWarnings: z.boolean().optional() }),
  output: z.object({ queued: z.boolean(), reply: replyOut }),
  permission: "review:publish",
  kind: "write",
  approval: "own_flow",
  async handler(ctx, input) {
    const { tx, actor } = ctx;
    const { reply } = await loadReply(tx, actor, input.id, "review:publish");
    if (reply.status !== "approved" && reply.status !== "failed") {
      throw new CoreError(
        "CONFLICT",
        `Only an approved or failed reply can be published (this one is ${reply.status})`,
      );
    }
    const set = {
      publishRequestedBy: actor.userId,
      publishRequestedAt: new Date(),
      failureReason: null,
      warningsAcknowledged: reply.warningsAcknowledged || input.acknowledgeWarnings === true,
      updatedAt: new Date(),
    };
    let row: ReplyRow;
    if (reply.status === "failed") {
      // transitionReply audits the retry; the publish_requested row below records the request.
      row = await transitionReply(tx, {
        reply,
        to: "approved",
        action: "retry_requested",
        set,
        audit: ctx.audit,
      });
    } else {
      [row] = (await tx
        .update(reviewReplies)
        .set(set)
        .where(eq(reviewReplies.id, reply.id))
        .returning()) as [ReplyRow];
    }
    await requestPublish(ctx, row, { retry: reply.status === "failed" });
    return { queued: true, reply: toReplyOut(actor, row) };
  },
});

export const reviewRepliesDeletePublished = defineAction({
  name: "reviewReplies.deletePublished",
  description:
    "Queue removal of the review's Google reply (a reply published here or made in Google). Asynchronous: audits the request and queues a worker job in the same transaction, returning { queued: true }. When the job finishes the review has no reply and the published revision is deleted. CONFLICT if the review has no Google reply.",
  input: z.object({ reviewId: z.uuid() }),
  output: z.object({ queued: z.boolean() }),
  permission: "review:publish",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const review = await loadReview(tx, actor, input.reviewId, "review:publish");
    if (review.replyComment === null) {
      throw new CoreError("CONFLICT", "Review has no Google reply to delete");
    }
    const [published] = await tx
      .select({ id: reviewReplies.id })
      .from(reviewReplies)
      .where(and(eq(reviewReplies.reviewId, review.id), eq(reviewReplies.status, "published")))
      .orderBy(desc(reviewReplies.revision))
      .limit(1);
    const jobId = await enqueueJob(tx, REPLY_DELETE_QUEUE, {
      reviewId: review.id,
      requestedBy: actor.userId,
    });
    await audit({
      action: "review_reply.delete_requested",
      entityType: published ? "review_reply" : "review",
      entityId: published?.id ?? review.id,
      before: { status: published ? "published" : "published_external" },
      after: { reviewId: review.id, requestedBy: actor.userId, jobId },
    });
    return { queued: true };
  },
});

export const reviewRepliesList = defineAction({
  name: "reviewReplies.list",
  description:
    "All reply revisions of one review, newest revision first, with each revision's status, guardrail result and what the caller may do next (can.edit/submit/approve/reject/publish). The review block says whether the caller can start a draft (canDraft: no open revision), delete the Google reply, and whether a Google reply exists. Poll this after reviewReplies.publish.",
  input: z.object({ reviewId: z.uuid() }),
  output: z.object({
    revisions: z.array(replyOut),
    review: z.object({
      hasGoogleReply: z.boolean(),
      openRevisionId: z.string().nullable(),
      canDraft: z.boolean(),
      canDeletePublished: z.boolean(),
    }),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const review = await loadReview(tx, actor, input.reviewId, "review:read");
    const rows = await tx
      .select()
      .from(reviewReplies)
      .where(and(eq(reviewReplies.reviewId, review.id), eq(reviewReplies.orgId, actor.orgId)))
      .orderBy(desc(reviewReplies.revision));
    const open = rows.find((r) => (OPEN_STATUSES as readonly string[]).includes(r.status));
    return {
      revisions: rows.map((r) => toReplyOut(actor, r)),
      review: {
        hasGoogleReply: review.replyComment !== null,
        openRevisionId: open?.id ?? null,
        canDraft: roleHasPermission(actor.role, "review:draft") && !open,
        canDeletePublished:
          roleHasPermission(actor.role, "review:publish") && review.replyComment !== null,
      },
    };
  },
});

const queueItem = z.object({
  reply: replyOut,
  review: z.object({
    id: z.string(),
    rating: z.number().int().nullable(),
    comment: z.string().nullable(),
    reviewerDisplayName: z.string().nullable(),
    locationName: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    googleReply: z.string().nullable(),
  }),
});

const ms = sql`date_trunc('milliseconds', ${reviewReplies.updatedAt})`;

export const reviewRepliesListQueue = defineAction({
  name: "reviewReplies.listQueue",
  description:
    "Approval and attention queue: replies in one status (pending_approval, blocked, failed, approved or conflict) across the workspaces the caller can see (or one workspaceId), at active locations, oldest update first. Each item carries the reply (with guardrail result and can.* flags) and the review it answers. limit 1-100 (default 25); pass nextCursor as cursor for the next page.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    status: z.enum(["pending_approval", "blocked", "failed", "approved", "conflict"]),
    cursor: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: z.object({ items: z.array(queueItem), nextCursor: z.string().nullable() }),
  permission: "review:approve",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:approve", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await tx
      .select({
        reply: reviewReplies,
        review: reviews,
        workspaceName: workspaces.name,
        locationName: locations.name,
      })
      .from(reviewReplies)
      .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .innerJoin(workspaces, eq(workspaces.id, reviewReplies.workspaceId))
      .where(
        and(
          eq(reviewReplies.orgId, actor.orgId),
          eq(locations.orgId, actor.orgId),
          eq(locations.status, "active"),
          eq(reviewReplies.status, input.status),
          scope === "all" ? undefined : inArray(reviewReplies.workspaceId, scope),
          input.workspaceId ? eq(reviewReplies.workspaceId, input.workspaceId) : undefined,
          after
            ? sql`(${ms}, ${reviewReplies.id}) > (${after.t}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(ms), asc(reviewReplies.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ reply, review, workspaceName, locationName }) => ({
        reply: toReplyOut(actor, reply),
        review: {
          id: review.id,
          rating: review.starRating,
          comment: review.comment,
          reviewerDisplayName: review.reviewerDisplayName,
          locationName,
          workspaceId: reply.workspaceId,
          workspaceName,
          googleReply: review.replyComment,
        },
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({
              createTime: new Date(Math.floor(last.reply.updatedAt.getTime())),
              id: last.reply.id,
            })
          : null,
    };
  },
});
