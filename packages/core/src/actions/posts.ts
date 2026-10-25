import { useAccountDaily } from "../limits/counters";
import { and, asc, desc, eq, exists, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, postTargets, posts, users, workspaces, type Tx } from "@opengmb/db";
import { narrowTo } from "../approval-queue";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { notifyApprovalRequested } from "../approvals";
import { POST_LIMITS } from "../config/post-limits";
import { CoreError } from "../errors";
import type { GoogleLocalPost } from "../google/client";
import type { GuardrailResult } from "../guardrails";
import { enqueueJob } from "../jobs";
import { roleHasPermission } from "../permissions";
import { postLanguageInput } from "../posts/language";
import { syncGooglePosts } from "../posts/google-sync";
import { googleOnlyPosts } from "../posts/scope";
import { guardrailPreview } from "./previewUtil";
import { defineAction, type ActionContext } from "../registry";
import { clientForLocation, googleNames, loadLocation } from "../locationOps/access";
import {
  contentFromRow,
  contentShape,
  mergeContent,
  postAuditFields,
  type PostContent,
  type PostRow,
} from "../posts/content";
import { checkPostAtLocations, pendingLocationIds } from "../posts/context";
import { POST_DELETE_QUEUE, startPublishing } from "../posts/jobs";
import { expandOccurrences, recurrenceInput, type Recurrence } from "../posts/recurrence";
import { postCapabilities, transitionPost } from "../posts/state";

const violationOut = z.object({
  ruleId: z.string(),
  packId: z.string(),
  severity: z.enum(["block", "warn"]),
  status: z.enum(["active", "pending_counsel_review"]),
  message: z.string(),
  matches: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
});
export const guardrailOut = z.object({
  ok: z.boolean(),
  violations: z.array(violationOut),
  packs: z.array(z.string()),
});

const targetOut = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  occurrence: z.number().int(),
  status: z.enum(["pending", "published", "failed", "skipped", "deleted"]),
  googlePostName: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** A reason code (e.g. google_http_400, guardrail_blocked:P.phone); never Google's body. */
  error: z.string().nullable(),
});

const recurrenceOut = z.object({
  freq: z.enum(["weekly", "monthly"]),
  interval: z.number().int(),
  until: z.string().optional(),
  count: z.number().int().optional(),
  anchor: z.string(),
  /** The zone the series keeps its local clock time in (the workspace's when it was scheduled). Absent: UTC. */
  timeZone: z.string().optional(),
});

const postOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  language: postLanguageInput,
  topicType: z.enum(["STANDARD", "EVENT", "OFFER", "ALERT"]),
  alertType: z.string().nullable(),
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
  status: z.enum([
    "draft",
    "pending_approval",
    "approved",
    "scheduled",
    "publishing",
    "published",
    "failed",
    "blocked",
    "cancelled",
  ]),
  createdBy: z.string(),
  /** Names from users.name: who wrote, approved and cancelled it (null when nobody did). */
  createdByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  cancelledByName: z.string().nullable(),
  createdSurface: z.string(),
  /** The next (or, once sent, last) due time for a scheduled post. */
  scheduledFor: z.string().nullable(),
  recurrence: recurrenceOut.nullable(),
  /** Index of the current/next occurrence (0 = the first send). */
  occurrence: z.number().int(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  /** Display name of the person who sent the post back to draft (posts.reject); null if never. */
  rejectedByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  guardrail: guardrailOut.nullable(),
  warningsAcknowledged: z.boolean(),
  targets: z.array(targetOut),
  createdAt: z.string(),
  updatedAt: z.string(),
  can: z.object({
    edit: z.boolean(),
    submit: z.boolean(),
    approve: z.boolean(),
    reject: z.boolean(),
    schedule: z.boolean(),
    cancel: z.boolean(),
    deletePublished: z.boolean(),
  }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;
const NOT_FOUND = () => new AccessError("NOT_FOUND", "Post not found");

type TargetJoined = typeof postTargets.$inferSelect & { locationName: string };

async function targetsFor(tx: Tx, postIds: string[]): Promise<Map<string, TargetJoined[]>> {
  const map = new Map<string, TargetJoined[]>();
  if (postIds.length === 0) return map;
  const rows = await tx
    .select({ t: postTargets, locationName: locations.name })
    .from(postTargets)
    .innerJoin(locations, eq(locations.id, postTargets.locationId))
    .where(inArray(postTargets.postId, postIds))
    .orderBy(asc(postTargets.occurrence), asc(locations.name), asc(postTargets.id));
  for (const { t, locationName } of rows) {
    const list = map.get(t.postId) ?? [];
    list.push({ ...t, locationName });
    map.set(t.postId, list);
  }
  return map;
}

/** users.name for every person who touched these posts, by user id, in one query. */
async function namesFor(tx: Tx, rows: PostRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.createdBy, r.approvedBy, r.rejectedBy, r.cancelledBy])
        .filter((v): v is string => !!v),
    ),
  ];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}

function toPostOut(
  actor: Actor,
  r: PostRow,
  targets: TargetJoined[],
  names: Map<string, string>,
): z.input<typeof postOut> {
  const c = postCapabilities(actor, r.status);
  const content = contentFromRow(r);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    language: r.language,
    topicType: content.topicType,
    alertType: content.alertType,
    summary: content.summary,
    cta: content.cta,
    event: content.event,
    offer: content.offer,
    media: content.media,
    status: r.status,
    createdBy: r.createdBy,
    createdByName: nameOf(r.createdBy),
    approvedByName: nameOf(r.approvedBy),
    cancelledByName: nameOf(r.cancelledBy),
    createdSurface: r.createdSurface,
    scheduledFor: iso(r.scheduledFor),
    recurrence: (r.recurrence as Recurrence | null) ?? null,
    occurrence: r.occurrence,
    submittedAt: iso(r.submittedAt),
    approvedAt: iso(r.approvedAt),
    rejectedAt: iso(r.rejectedAt),
    rejectReason: r.rejectReason,
    rejectedByName: nameOf(r.rejectedBy),
    cancelledAt: iso(r.cancelledAt),
    guardrail: (r.guardrailResult as GuardrailResult | null) ?? null,
    warningsAcknowledged: r.warningsAcknowledged,
    targets: targets.map((t) => ({
      id: t.id,
      locationId: t.locationId,
      locationName: t.locationName,
      occurrence: t.occurrence,
      status: t.status,
      googlePostName: t.googlePostName,
      publishedAt: iso(t.publishedAt),
      error: t.error,
    })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    can: {
      edit: c.canEdit,
      submit: c.canSubmit,
      approve: c.canApprove,
      reject: c.canReject,
      schedule: c.canSchedule,
      cancel: c.canCancel,
      deletePublished:
        roleHasPermission(actor.role, "review:publish") &&
        targets.some((t) => t.status === "published"),
    },
  };
}

async function outFor(tx: Tx, actor: Actor, row: PostRow) {
  const map = await targetsFor(tx, [row.id]);
  return toPostOut(actor, row, map.get(row.id) ?? [], await namesFor(tx, [row]));
}

/**
 * A post the actor can see (same org, workspace in scope), otherwise NOT_FOUND (it does not reveal
 * that the id exists); then the permission check. `lock` row-locks so transitions serialise.
 */
export async function loadPost(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
  lock = true,
): Promise<PostRow> {
  const q = tx
    .select()
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.orgId, actor.orgId)));
  const [post] = lock ? await q.for("update") : await q;
  if (!post) throw NOT_FOUND();
  const scope = workspaceScope(actor);
  if (scope !== "all" && !scope.includes(post.workspaceId)) throw NOT_FOUND();
  authorize(actor, permission, { workspaceId: post.workspaceId });
  return post;
}

/** The language a new post starts in when the caller gives none. */
async function workspaceLanguage(tx: Tx, workspaceId: string) {
  const [w] = await tx
    .select({ language: workspaces.defaultPostLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return w?.language ?? "en";
}

export async function authorizeWorkspace(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  permission: Parameters<typeof authorize>[1],
) {
  authorize(actor, permission, { workspaceId });
  const [ws] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
}

/** Active locations of this workspace in the actor's org; anything else is INVALID_INPUT. */
/** The workspace's time zone, read when a series is scheduled and kept with it. */
export async function workspaceTimeZone(tx: Tx, workspaceId: string): Promise<string> {
  const [w] = await tx
    .select({ timeZone: workspaces.timeZone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return w?.timeZone ?? "UTC";
}

async function validateLocations(tx: Tx, actor: Actor, workspaceId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        inArray(locations.id, unique),
        eq(locations.orgId, actor.orgId),
        eq(locations.workspaceId, workspaceId),
        eq(locations.status, "active"),
      ),
    );
  if (rows.length !== unique.length) {
    throw new CoreError("INVALID_INPUT", "Unknown or inactive location for this workspace");
  }
  return unique;
}

/** Replace the pending targets of the post's current occurrence. */
async function replacePendingTargets(tx: Tx, post: PostRow, locationIds: string[]) {
  await tx
    .delete(postTargets)
    .where(
      and(
        eq(postTargets.postId, post.id),
        eq(postTargets.occurrence, post.occurrence),
        eq(postTargets.status, "pending"),
      ),
    );
  await tx.insert(postTargets).values(
    locationIds.map((locationId) => ({
      postId: post.id,
      orgId: post.orgId,
      locationId,
      occurrence: post.occurrence,
    })),
  );
}

const locationIdsInput = z.array(z.uuid()).min(1).max(100);
/** The send time picked in Compose, kept on the draft until someone schedules the approved post. An instant. */
const draftSendTime = z.iso.datetime({ offset: true });
const DRAFT_TIME_GRACE_MS = 60_000;
function draftSendTimeOf(iso: string): Date {
  const at = new Date(iso);
  if (at.getTime() < Date.now() - DRAFT_TIME_GRACE_MS) {
    throw new CoreError("INVALID_INPUT", "scheduledFor is in the past");
  }
  return at;
}
const updateShape = { ...contentShape, topicType: contentShape.topicType.optional() };

const createDraftInput = z.object({
  workspaceId: z.uuid(),
  locationIds: locationIdsInput,
  language: postLanguageInput.optional(),
  scheduledFor: draftSendTime.optional(),
  ...contentShape,
});

export const postsCheck = defineAction({
  name: "posts.check",
  description:
    "Dry-run the post guardrails for a candidate Google Business Profile post. Writes nothing. Returns { ok, violations, packs }: ok is false when any violation has severity block (blocks cannot be overridden); warn violations need acknowledgeWarnings on posts.submit. Rules (pack post): no phone numbers in text (use a CALL button, which uses the location's phone), summary at most 1,500 characters, at most 1 image, call to action rules (URL required except for CALL, none for CALL), ALERT restrictions, EVENT/OFFER need an event title and dates. Healthcare workspaces also apply H1 (care relationship wording), provider and staff names; legal workspaces apply LE3/LE4. Pass locationIds to check with those locations' names and phones.",
  input: z.object({
    workspaceId: z.uuid(),
    locationIds: locationIdsInput.optional(),
    ...contentShape,
  }),
  output: guardrailOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    await authorizeWorkspace(tx, actor, input.workspaceId, "review:read");
    const locationIds = input.locationIds
      ? await validateLocations(tx, actor, input.workspaceId, input.locationIds)
      : [];
    const content = mergeContent(emptyContent(input.topicType), input);
    return checkPostAtLocations(tx, { workspaceId: input.workspaceId, locationIds, content });
  },
});

function emptyContent(topicType: PostContent["topicType"]): PostContent {
  return {
    topicType,
    alertType: null,
    summary: "",
    cta: null,
    event: null,
    offer: null,
    media: [],
  };
}

/**
 * The draft insert shared by posts.createDraft and posts.bulkCreateDrafts: checks the locations,
 * writes the post, its pending targets and the audit row. The caller has already authorized the
 * workspace (review:draft).
 */
export async function insertDraft(
  { tx, actor, audit }: Pick<ActionContext, "tx" | "actor" | "audit">,
  input: z.output<typeof createDraftInput>,
): Promise<PostRow> {
  const locationIds = await validateLocations(tx, actor, input.workspaceId, input.locationIds);
  const c = mergeContent(emptyContent(input.topicType), input);
  const language = input.language ?? (await workspaceLanguage(tx, input.workspaceId));
  const scheduledFor = input.scheduledFor ? draftSendTimeOf(input.scheduledFor) : null;
  const [row] = await tx
    .insert(posts)
    .values({
      orgId: actor.orgId,
      workspaceId: input.workspaceId,
      createdBy: actor.userId,
      createdSurface: actor.surface,
      topicType: c.topicType,
      language,
      alertType: c.alertType,
      summary: c.summary,
      cta: c.cta,
      event: c.event,
      offer: c.offer,
      media: c.media,
      scheduledFor,
      updatedAt: new Date(),
    })
    .returning();
  await replacePendingTargets(tx, row!, locationIds);
  await audit({
    action: "post.draft_created",
    entityType: "post",
    entityId: row!.id,
    before: null,
    after: {
      status: "draft",
      ...postAuditFields(row!),
      language: row!.language,
      scheduledFor: scheduledFor?.toISOString() ?? null,
      locationCount: locationIds.length,
    },
  });
  return row!;
}

export const postsCreateDraft = defineAction({
  name: "posts.createDraft",
  description:
    "Create a draft Google Business Profile post for one or more locations of a workspace. topicType STANDARD (summary, optional CTA and one image), EVENT (event title + start/end dates, times optional), OFFER (event plus optional couponCode, redeemOnlineUrl, termsConditions; Google ignores a CTA on offers) or ALERT (alertType COVID_19; Google has disabled new COVID_19 alerts). callToAction actionType BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP (all need an https url) or CALL (no url; uses the location's phone). media: one image by URL (uploads are not built yet). Do not put phone numbers in the summary. The draft is not sent anywhere: call posts.submit, which runs the guardrails. Content problems do not fail this call; posts.check shows them. language: the post's language, a BCP 47 code (en, es, fr, de, it, pt, nl, vi, zh, ko, ja, ar, hi, gu); omitted = the workspace's default post language (workspaces.list defaultPostLanguage). Sent to Google as languageCode. A bilingual post is two posts. scheduledFor (optional, ISO datetime with offset, not in the past) is the send time picked in Compose: it is only remembered on the draft and shown to the approver, nothing is sent until posts.schedule.",
  input: createDraftInput,
  output: z.object({ post: postOut }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview({ read }, input) {
    const result = (await read("posts.check", input)) as GuardrailResult;
    return guardrailPreview("Draft post", result, {
      after: { summary: input.summary, topicType: input.topicType, locationIds: input.locationIds },
    });
  },
  async handler({ tx, actor, audit }, input) {
    await authorizeWorkspace(tx, actor, input.workspaceId, "review:draft");
    const row = await insertDraft({ tx, actor, audit }, input);
    return { post: await outFor(tx, actor, row) };
  },
});

export const postsUpdateDraft = defineAction({
  name: "posts.updateDraft",
  description:
    "Change a post that is a draft or blocked (a blocked post goes back to draft, with its guardrail result cleared). Send only the fields to change; a field sent as null (cta, event, offer, alertType) is cleared; media replaces the list; locationIds replaces the target locations. Posts that are pending approval, approved, scheduled or published cannot be edited: reject or cancel first. language changes the post's language. scheduledFor changes the remembered send time (null clears it; not in the past); omitted keeps it.",
  input: z.object({
    id: z.uuid(),
    locationIds: locationIdsInput.optional(),
    language: postLanguageInput.optional(),
    scheduledFor: draftSendTime.nullish(),
    ...updateShape,
  }),
  output: z.object({ post: postOut }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const post = await loadPost(tx, actor, input.id, "review:draft");
    if (post.status !== "draft" && post.status !== "blocked") {
      throw new CoreError("CONFLICT", `A ${post.status} post cannot be edited`);
    }
    const c = mergeContent(contentFromRow(post), input);
    const scheduledFor =
      input.scheduledFor === undefined
        ? undefined
        : input.scheduledFor === null
          ? null
          : draftSendTimeOf(input.scheduledFor);
    if (input.locationIds) {
      await replacePendingTargets(
        tx,
        post,
        await validateLocations(tx, actor, post.workspaceId, input.locationIds),
      );
    }
    const set = {
      topicType: c.topicType,
      alertType: c.alertType,
      summary: c.summary,
      cta: c.cta,
      event: c.event,
      offer: c.offer,
      media: c.media,
      ...(input.language ? { language: input.language } : {}),
      ...(scheduledFor !== undefined ? { scheduledFor } : {}),
      guardrailResult: null,
      warningsAcknowledged: false,
      updatedAt: new Date(),
    };
    const previousSha = postAuditFields(post).summarySha256;
    let row: PostRow;
    if (post.status === "blocked") {
      row = await transitionPost(tx, {
        post,
        to: "draft",
        action: "draft_updated",
        set,
        audit,
        extra: { previousSummarySha256: previousSha, ...(scheduledFor !== undefined ? { scheduledFor: scheduledFor?.toISOString() ?? null } : {}) },
      });
    } else {
      [row] = (await tx.update(posts).set(set).where(eq(posts.id, post.id)).returning()) as [
        PostRow,
      ];
      await audit({
        action: "post.draft_updated",
        entityType: "post",
        entityId: row.id,
        before: { status: "draft", occurrence: row.occurrence },
        after: {
          status: "draft",
          ...postAuditFields(row),
          scheduledFor: row.scheduledFor?.toISOString() ?? null,
          previousSummarySha256: previousSha,
        },
      });
    }
    return { post: await outFor(tx, actor, row) };
  },
});

const submitOut = z.object({
  /**
   * blocked: a block-severity rule fired (status blocked, edit to fix). needs_acknowledgement: only
   * warnings fired and acknowledgeWarnings was not true; the post stays draft. pending_approval:
   * submitted (posts always need a human approval).
   */
  outcome: z.enum(["blocked", "needs_acknowledgement", "pending_approval"]),
  code: z.string().nullable(),
  post: postOut,
  result: guardrailOut,
});

export const postsSubmit = defineAction({
  name: "posts.submit",
  description:
    "Submit a draft post: runs the guardrails for every target location. Any block-severity violation sets status blocked and returns the violations (not an error). Warnings only: the post stays a draft with outcome needs_acknowledgement and code WARNINGS_REQUIRE_ACKNOWLEDGEMENT; call again with acknowledgeWarnings true. Otherwise the post becomes pending_approval: posts always need a person with approval rights (there is no auto-approve). Guardrails run again, per location, just before the post is sent to Google.",
  input: z.object({ id: z.uuid(), acknowledgeWarnings: z.boolean().optional() }),
  output: submitOut,
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input): Promise<z.input<typeof submitOut>> {
    const post = await loadPost(tx, actor, input.id, "review:draft");
    if (post.status !== "draft") {
      throw new CoreError(
        "CONFLICT",
        `Only a draft can be submitted (this post is ${post.status})`,
      );
    }
    const locationIds = await pendingLocationIds(tx, post.id, post.occurrence);
    if (locationIds.length === 0) throw new CoreError("INVALID_INPUT", "Post has no locations");
    const result = await checkPostAtLocations(tx, {
      workspaceId: post.workspaceId,
      locationIds,
      content: contentFromRow(post),
    });
    const now = new Date();
    if (!result.ok) {
      const row = await transitionPost(tx, {
        post,
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
        post: await outFor(tx, actor, row),
        result,
      };
    }
    const hasWarnings = result.violations.length > 0;
    if (hasWarnings && input.acknowledgeWarnings !== true) {
      const [row] = (await tx
        .update(posts)
        .set({ guardrailResult: result, updatedAt: now })
        .where(eq(posts.id, post.id))
        .returning()) as [PostRow];
      await audit({
        action: "post.acknowledgement_required",
        entityType: "post",
        entityId: row.id,
        before: { status: "draft", occurrence: row.occurrence },
        after: { status: "draft", ...postAuditFields(row, result) },
      });
      return {
        outcome: "needs_acknowledgement",
        code: "WARNINGS_REQUIRE_ACKNOWLEDGEMENT",
        post: await outFor(tx, actor, row),
        result,
      };
    }
    const row = await transitionPost(tx, {
      post,
      to: "pending_approval",
      action: "submitted",
      set: {
        guardrailResult: result,
        warningsAcknowledged: hasWarnings,
        submittedBy: actor.userId,
        submittedAt: now,
      },
      audit,
      guardrail: result,
      extra: { warningsAcknowledged: hasWarnings },
    });
    await notifyApprovalRequested(tx, audit, {
      orgId: actor.orgId,
      workspaceId: row.workspaceId,
      type: "post",
      id: row.id,
      submittedAt: row.submittedAt ?? now,
    });
    return { outcome: "pending_approval", code: null, post: await outFor(tx, actor, row), result };
  },
});

export const postsApprove = defineAction({
  name: "posts.approve",
  description:
    "Approve a post that is pending approval (pending_approval -> approved). Approving does not send it: call posts.schedule. Client approvers can approve posts in their own workspaces only.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ post: postOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const post = await loadPost(tx, actor, input.id, "review:approve");
    const row = await transitionPost(tx, {
      post,
      to: "approved",
      action: "approved",
      set: { approvedBy: actor.userId, approvedAt: new Date() },
      audit,
    });
    return { post: await outFor(tx, actor, row) };
  },
});

export const postsReject = defineAction({
  name: "posts.reject",
  description:
    "Reject a post that is pending approval: it goes back to draft with the reason shown to the author (pending_approval -> draft). The author edits and resubmits.",
  input: z.object({ id: z.uuid(), reason: z.string().min(1).max(2_000) }),
  output: z.object({ post: postOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const post = await loadPost(tx, actor, input.id, "review:approve");
    const row = await transitionPost(tx, {
      post,
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
    return { post: await outFor(tx, actor, row) };
  },
});

const GRACE_MS = 60_000;

export const postsSchedule = defineAction({
  name: "posts.schedule",
  description:
    "Schedule an approved post. Google's native scheduling is not used: Synectus keeps the schedule and a worker sweeps every minute, sending posts that are due (so a send can be up to about a minute late). Omit scheduledFor to send now (the worker is queued in this call, nothing is sent to Google inside it). scheduledFor is an ISO datetime with offset (an instant), not in the past. recurrence { freq weekly|monthly, interval (default 1), and until (inclusive, ISO) and/or count (total sends including the first) } repeats it; one of until or count is required; a series keeps the same local clock time in the workspace's time zone (workspaces.list timeZone) across daylight-saving changes. locationIds optionally replaces the target locations. The worker runs the guardrails again for each location right before sending; one location failing does not stop the others. Poll posts.get for per-location results.",
  input: z.object({
    id: z.uuid(),
    scheduledFor: z.iso.datetime({ offset: true }).optional(),
    recurrence: recurrenceInput.optional(),
    locationIds: locationIdsInput.optional(),
  }),
  output: z.object({ post: postOut, sendQueued: z.boolean() }),
  permission: "review:publish",
  kind: "write",
  approval: "own_flow",
  async handler(ctx, input) {
    const { tx, actor, audit } = ctx;
    const post = await loadPost(tx, actor, input.id, "review:publish");
    if (post.status !== "approved") {
      throw new CoreError(
        "CONFLICT",
        `Only an approved post can be scheduled (this post is ${post.status})`,
      );
    }
    const now = new Date();
    const start = input.scheduledFor ? new Date(input.scheduledFor) : now;
    if (start.getTime() < now.getTime() - GRACE_MS) {
      throw new CoreError("INVALID_INPUT", "scheduledFor is in the past");
    }
    let recurrence: Recurrence | null = null;
    if (input.recurrence) {
      const r = input.recurrence;
      if (r.until !== undefined && Date.parse(r.until) <= start.getTime()) {
        throw new CoreError("INVALID_INPUT", "recurrence.until must be after scheduledFor");
      }
      recurrence = {
        freq: r.freq,
        interval: r.interval,
        ...(r.until !== undefined ? { until: new Date(r.until).toISOString() } : {}),
        ...(r.count !== undefined ? { count: r.count } : {}),
        anchor: start.toISOString(),
        timeZone: await workspaceTimeZone(tx, post.workspaceId),
      };
    }
    if (input.locationIds) {
      await replacePendingTargets(
        tx,
        post,
        await validateLocations(tx, actor, post.workspaceId, input.locationIds),
      );
    }
    if ((await pendingLocationIds(tx, post.id, post.occurrence)).length === 0) {
      throw new CoreError("INVALID_INPUT", "Post has no locations");
    }
    let row = await transitionPost(tx, {
      post,
      to: "scheduled",
      action: "scheduled",
      set: {
        scheduledFor: start,
        recurrence,
        occurrence: 0,
        scheduledBy: actor.userId,
        scheduledAt: now,
      },
      audit,
      extra: {
        scheduledFor: start.toISOString(),
        recurring: recurrence !== null,
        ...(recurrence
          ? {
              freq: recurrence.freq,
              interval: recurrence.interval,
              count: recurrence.count ?? null,
            }
          : {}),
      },
    });
    const dueNow = start.getTime() <= now.getTime();
    if (dueNow) row = await startPublishing(tx, { post: row, audit, trigger: "schedule_now" });
    return { post: await outFor(tx, actor, row), sendQueued: dueNow };
  },
});

export const postsCancel = defineAction({
  name: "posts.cancel",
  description:
    "Cancel a post that has not been sent: draft, blocked, pending_approval, approved or scheduled (a recurring series stops; posts already published stay on Google, use posts.deletePublished to remove them). A post that is being sent right now (publishing) cannot be cancelled: CONFLICT.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ post: postOut }),
  permission: "review:publish",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const post = await loadPost(tx, actor, input.id, "review:publish");
    if (!postCapabilities(actor, post.status).canCancel) {
      throw new CoreError("CONFLICT", `A ${post.status} post cannot be cancelled`);
    }
    await tx
      .update(postTargets)
      .set({ status: "skipped", error: "cancelled", updatedAt: new Date() })
      .where(and(eq(postTargets.postId, post.id), eq(postTargets.status, "pending")));
    const row = await transitionPost(tx, {
      post,
      to: "cancelled",
      action: "cancelled",
      set: { cancelledBy: actor.userId, cancelledAt: new Date() },
      audit,
    });
    return { post: await outFor(tx, actor, row) };
  },
});

export const postsDeletePublished = defineAction({
  name: "posts.deletePublished",
  description:
    "Queue removal of the Google posts this post published (at all its locations, or only locationIds). Asynchronous: audits the request and queues a worker job in the same transaction, returning { queued: true }. When the job finishes those per-location results are deleted (Google 404 counts as deleted). CONFLICT if there is nothing published to delete.",
  input: z.object({ id: z.uuid(), locationIds: locationIdsInput.optional() }),
  output: z.object({ queued: z.boolean(), targetCount: z.number().int() }),
  permission: "review:publish",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const post = await loadPost(tx, actor, input.id, "review:publish", false);
    const targets = await tx
      .select({ id: postTargets.id })
      .from(postTargets)
      .where(
        and(
          eq(postTargets.postId, post.id),
          eq(postTargets.status, "published"),
          input.locationIds ? inArray(postTargets.locationId, input.locationIds) : undefined,
        ),
      );
    if (targets.length === 0) throw new CoreError("CONFLICT", "No published post to delete");
    const jobId = await enqueueJob(tx, POST_DELETE_QUEUE, {
      postId: post.id,
      locationIds: input.locationIds ?? null,
      requestedBy: actor.userId,
    });
    await audit({
      action: "post.delete_requested",
      entityType: "post",
      entityId: post.id,
      before: { status: post.status },
      after: {
        ...postAuditFields(post),
        requestedBy: actor.userId,
        targetCount: targets.length,
        jobId,
      },
    });
    return { queued: true, targetCount: targets.length };
  },
});

export const postsGet = defineAction({
  name: "posts.get",
  description:
    "One post with its content, status, guardrail result, what the caller may do next (can.*) and the per-location results of every send (targets: status, googlePostName, publishedAt, error reason code).",
  input: z.object({ id: z.uuid() }),
  output: z.object({ post: postOut }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const post = await loadPost(tx, actor, input.id, "review:read", false);
    return { post: await outFor(tx, actor, post) };
  },
});

/**
 * A post that is live on a location's Google profile but was made outside SynGMB (Google's own app,
 * another tool), from the google_posts mirror. It has no SynGMB workflow: no approve, no edit.
 */
const googleOnlyOut = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  workspaceId: z.string(),
  googlePostName: z.string(),
  topicType: z.string(),
  summary: z.string(),
  eventTitle: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  /** "View on Google" link when Google gave one. */
  searchUrl: z.string().nullable(),
  ctaType: z.string().nullable(),
  /** When it went up on Google (ISO), null if Google gave no date. */
  at: z.string().nullable(),
});

export const postsList = defineAction({
  name: "posts.list",
  description:
    "Posts the caller can see, newest first. Filters: workspaceId, status, topicType, q (case-insensitive text in the summary), locationId (posts that target it), from (inclusive) and to (exclusive) ISO datetimes applied to the scheduled time (or the creation time when unscheduled). sort oldest_submitted lists the earliest submission first (unsubmitted last) instead of newest first. limit 1-100 (default 50). Each post carries its per-location targets. Use status pending_approval for the approval queue. googleOnly lists posts that are live on Google but were made outside OpenGMB (same filters, except status: only with no status or published); an OpenGMB post that is also on Google appears in posts only.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    status: postOut.shape.status.optional(),
    topicType: postOut.shape.topicType.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    sort: z.enum(["newest", "oldest_submitted"]).default("newest"),
    locationId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    posts: z.array(postOut),
    /** Posts on Google that were made outside SynGMB (see googleOnlyOut). Empty under a status other than published. */
    googleOnly: z.array(googleOnlyOut),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const when = sql`coalesce(${posts.scheduledFor}, ${posts.createdAt})`;
    const rows = await tx
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.orgId, actor.orgId),
          scope === "all" ? undefined : inArray(posts.workspaceId, scope),
          input.workspaceId ? eq(posts.workspaceId, input.workspaceId) : undefined,
          input.status ? eq(posts.status, input.status) : undefined,
          input.topicType ? eq(posts.topicType, input.topicType) : undefined,
          input.q ? ilike(posts.summary, `%${input.q.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
          input.locationId
            ? exists(
                tx
                  .select({ one: sql`1` })
                  .from(postTargets)
                  .where(
                    and(
                      eq(postTargets.postId, posts.id),
                      eq(postTargets.locationId, input.locationId),
                    ),
                  ),
              )
            : undefined,
          input.from ? sql`${when} >= ${input.from}::timestamptz` : undefined,
          input.to ? sql`${when} < ${input.to}::timestamptz` : undefined,
        ),
      )
      .orderBy(
        ...(input.sort === "oldest_submitted"
          ? [sql`${posts.submittedAt} asc nulls last`, asc(posts.id)]
          : [desc(posts.createdAt), desc(posts.id)]),
      )
      .limit(input.limit);
    const targets = await targetsFor(
      tx,
      rows.map((r) => r.id),
    );
    const names = await namesFor(tx, rows);
    const googleOnly =
      input.status && input.status !== "published"
        ? []
        : await googleOnlyPosts(tx, {
            orgId: actor.orgId,
            workspaceIds: scope === "all" ? null : scope,
            workspaceId: input.workspaceId,
            locationIds: input.locationId ? [input.locationId] : undefined,
            topicType: input.topicType,
            text: input.q,
            from: input.from ? new Date(input.from) : undefined,
            to: input.to ? new Date(input.to) : undefined,
            limit: input.limit,
          });
    return {
      posts: rows.map((r) => toPostOut(actor, r, targets.get(r.id) ?? [], names)),
      googleOnly,
    };
  },
});

const calendarEntry = z.object({
  postId: z.string(),
  workspaceId: z.string(),
  occurrence: z.number().int(),
  at: z.string(),
  /**
   * scheduled: the next send of a scheduled post. projected: a future occurrence of a recurring
   * post (not yet created). published / failed / skipped: a past send (best result among its locations).
   * google: a post made outside SynGMB, on its Google date (postId is the mirror row's id, postStatus "made_on_google").
   */
  kind: z.enum(["scheduled", "projected", "published", "failed", "skipped", "google"]),
  postStatus: z.string(),
  topicType: z.string(),
  summaryPreview: z.string(),
  /** "View on Google" link, only on kind google. */
  searchUrl: z.string().nullable().optional(),
  locationIds: z.array(z.string()),
  counts: z.object({
    published: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    deleted: z.number().int(),
  }),
});

export const postsCalendar = defineAction({
  name: "posts.calendar",
  description:
    "Calendar entries between from (inclusive) and to (exclusive), at most 366 days apart: scheduled sends, projected future occurrences of recurring posts (expanded only inside the window, respecting until/count), and past sends (published, failed or skipped, grouped per post and occurrence with per-status location counts), plus posts made outside OpenGMB that are live on Google (kind google, on their Google date). Optional workspaceId, and optional locationIds (up to 500) or groupId to keep only entries that touch those locations. Entry times are ISO instants. truncated is true if the entry cap (1000) was hit.",
  input: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    workspaceId: z.uuid().optional(),
    /** Keep only entries that touch one of these locations (a location scope). */
    locationIds: z.array(z.uuid()).max(500).optional(),
    /** Keep only entries that touch an active location of this group, resolved here (a group scope of any size); instead of locationIds, not with it. */
    groupId: z.uuid().optional(),
  }),
  output: z.object({ entries: z.array(calendarEntry), truncated: z.boolean() }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const start = new Date(input.from);
    const end = new Date(input.to);
    if (end.getTime() <= start.getTime()) {
      throw new CoreError("INVALID_INPUT", "to must be after from");
    }
    if (end.getTime() - start.getTime() > POST_LIMITS.calendarMaxWindowDays * 86_400_000) {
      throw new CoreError(
        "INVALID_INPUT",
        `Window is longer than ${POST_LIMITS.calendarMaxWindowDays} days`,
      );
    }
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const visible = and(
      eq(posts.orgId, actor.orgId),
      scope === "all" ? undefined : inArray(posts.workspaceId, scope),
      input.workspaceId ? eq(posts.workspaceId, input.workspaceId) : undefined,
    );
    const max = POST_LIMITS.calendarMaxEntries;
    const entries: z.input<typeof calendarEntry>[] = [];
    const preview = (s: string) => Array.from(s).slice(0, 80).join("");
    const none = { published: 0, failed: 0, skipped: 0, deleted: 0 };

    // Upcoming: scheduled (and being sent) posts, expanded for recurrence inside the window.
    const upcoming = await tx
      .select()
      .from(posts)
      .where(and(visible, inArray(posts.status, ["scheduled", "publishing"])));
    for (const p of upcoming) {
      if (!p.scheduledFor) continue;
      const pending = (
        await tx
          .select({ locationId: postTargets.locationId })
          .from(postTargets)
          .where(
            and(
              eq(postTargets.postId, p.id),
              eq(postTargets.occurrence, p.occurrence),
              eq(postTargets.status, "pending"),
            ),
          )
      ).map((r) => r.locationId);
      const rec = p.recurrence as Recurrence | null;
      const slots = rec
        ? expandOccurrences(rec, p.occurrence, { start, end }, max)
        : p.scheduledFor >= start && p.scheduledFor < end
          ? [{ index: p.occurrence, at: p.scheduledFor }]
          : [];
      for (const s of slots) {
        entries.push({
          postId: p.id,
          workspaceId: p.workspaceId,
          occurrence: s.index,
          at: s.at.toISOString(),
          kind: s.index === p.occurrence ? "scheduled" : "projected",
          postStatus: p.status,
          topicType: p.topicType,
          summaryPreview: preview(p.summary),
          locationIds: pending,
          counts: none,
        });
      }
    }

    // Past: results of sends, grouped per post and occurrence.
    const when = sql<Date>`coalesce(${postTargets.publishedAt}, ${postTargets.updatedAt})`;
    const sent = await tx
      .select({ t: postTargets, p: posts, at: when })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(
        and(
          visible,
          inArray(postTargets.status, ["published", "failed", "skipped", "deleted"]),
          sql`${when} >= ${start.toISOString()}::timestamptz`,
          sql`${when} < ${end.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(when));
    const groups = new Map<string, z.input<typeof calendarEntry>>();
    for (const { t, p, at } of sent) {
      const key = `${p.id}:${t.occurrence}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          postId: p.id,
          workspaceId: p.workspaceId,
          occurrence: t.occurrence,
          at: new Date(at).toISOString(),
          kind: "skipped",
          postStatus: p.status,
          topicType: p.topicType,
          summaryPreview: preview(p.summary),
          locationIds: [],
          counts: { ...none },
        };
        groups.set(key, g);
      }
      g.locationIds.push(t.locationId);
      g.counts[t.status as keyof typeof none]++;
    }
    for (const g of groups.values()) {
      g.kind =
        g.counts.published + g.counts.deleted > 0
          ? "published"
          : g.counts.failed > 0
            ? "failed"
            : "skipped";
      entries.push(g);
    }
    for (const g of await googleOnlyPosts(tx, {
      orgId: actor.orgId,
      workspaceIds: scope === "all" ? null : scope,
      workspaceId: input.workspaceId,
      from: start,
      to: end,
      limit: max,
    })) {
      entries.push({
        postId: g.id,
        workspaceId: g.workspaceId,
        occurrence: 0,
        at: g.at!,
        kind: "google",
        postStatus: "made_on_google",
        topicType: g.topicType,
        summaryPreview: preview(g.summary),
        searchUrl: g.searchUrl,
        locationIds: [g.locationId],
        counts: { ...none },
      });
    }
    const narrow = narrowTo(actor, input);
    const wanted = !narrow
      ? null
      : Array.isArray(narrow)
        ? new Set(narrow)
        : new Set((await tx.select({ id: locations.id }).from(locations).where(inArray(locations.id, narrow))).map((r) => r.id));
    const kept = wanted ? entries.filter((e) => e.locationIds.some((id) => wanted.has(id))) : entries;
    kept.sort((a, b) => a.at.localeCompare(b.at) || a.postId.localeCompare(b.postId));
    return { entries: kept.slice(0, max), truncated: kept.length > max };
  },
});

const googlePostOut = z.object({
  name: z.string(),
  topicType: z.string(),
  state: z.string().nullable(),
  summary: z.string().nullable(),
  callToAction: z.object({ actionType: z.string(), url: z.string().nullable() }).nullable(),
  eventTitle: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  searchUrl: z.string().nullable(),
  createTime: z.string().nullable(),
  updateTime: z.string().nullable(),
  /** true when this app published it (a post target carries this Google name). */
  managedHere: z.boolean(),
});

export const postsGoogleList = defineAction({
  name: "posts.googleList",
  description:
    "List the posts currently on a location's Google Business Profile, live from Google, including ones made outside this app (in the Google UI or another tool). Newest first as Google returns them. managedHere marks posts this app published. Read only; calls Google, so it runs outside any database transaction.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    posts: z.array(googlePostOut),
    truncated: z.boolean(),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    const { parent } = googleNames(loc);
    const found: GoogleLocalPost[] = [];
    let pageToken: string | undefined;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page === POST_LIMITS.listMaxPages) {
        truncated = true;
        break;
      }
      const res = await client.listLocalPosts(parent, {
        pageSize: POST_LIMITS.listPageSize.limit,
        ...(pageToken ? { pageToken } : {}),
      });
      found.push(...res.localPosts);
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    const names = found.map((p) => p.name).filter((n): n is string => !!n);
    const managed = new Set(
      names.length === 0
        ? []
        : (
            await db
              .select({ name: postTargets.googlePostName })
              .from(postTargets)
              .where(
                and(eq(postTargets.orgId, actor.orgId), inArray(postTargets.googlePostName, names)),
              )
          ).map((r) => r.name),
    );
    return {
      location: { id: loc.id, name: loc.name, workspaceId: loc.workspaceId },
      posts: found.map((p) => ({
        name: p.name ?? "",
        topicType: p.topicType,
        state: p.state ?? null,
        summary: p.summary ?? null,
        callToAction: p.callToAction
          ? { actionType: p.callToAction.actionType, url: p.callToAction.url ?? null }
          : null,
        eventTitle: p.event?.title ?? null,
        mediaUrl: p.media?.[0]?.googleUrl ?? p.media?.[0]?.sourceUrl ?? null,
        searchUrl: p.searchUrl ?? null,
        createTime: p.createTime ?? null,
        updateTime: p.updateTime ?? null,
        managedHere: !!p.name && managed.has(p.name),
      })),
      truncated,
    };
  },
});

export const postsSyncGoogle = defineAction({
  name: "posts.syncGoogle",
  description:
    "Refresh OpenGMB's copy of one location's Google posts now, so All posts, the Calendar, Home, Performance and the Overview include posts made outside OpenGMB without waiting for the review sync (every 2 hours). Reads the posts from Google and stores them (a cache: Google is not changed, nothing is audited). Returns how many Google listed (fetched), how many stored copies of posts no longer on Google were dropped (removed), and truncated when Google had more pages than we read. Calls Google, so it runs outside any database transaction.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ fetched: z.number().int(), removed: z.number().int(), truncated: z.boolean() }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    await useAccountDaily(db, actor.orgId, "google_sync", 1);
    const client = await clientForLocation(db, actor, loc);
    return syncGooglePosts(db, loc, client);
  },
});
