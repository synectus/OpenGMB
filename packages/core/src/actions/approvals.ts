import { z } from "zod";
import { authorize, workspaceScope } from "../actor";
import {
  approvalTotals,
  bySubmitted,
  countPending,
  narrowTo,
  pendingChangeSets,
  pendingPostEdits,
  pendingPosts,
  pendingReplies,
} from "../approval-queue";
import { defineAction } from "../registry";

const countsOut = z.object({
  reply: z.number().int(),
  post: z.number().int(),
  changeset: z.number().int(),
  postedit: z.number().int(),
  total: z.number().int(),
});

const itemOut = z.object({
  type: z.enum(["reply", "post", "changeset", "postedit"]),
  /** The id of the reply, post, change set or post edit (a postedit item is acted on by this id). */
  id: z.string(),
  /** postedit items: the published post being edited (open /posts?post=<postId>). */
  postId: z.string().nullable(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  /** Names only, kept for older clients; `locations` is the same list with ids and addresses. */
  locationNames: z.array(z.string()),
  /** Where it is for. Same-named listings differ by id; addressSummary tells them apart. */
  locations: z.array(z.object({ id: z.string(), name: z.string(), addressSummary: z.string().nullable() })),
  submittedAt: z.string().nullable(),
  /** One line that says what is waiting: "Reply to a 2★ review from Maria G.", "Offer: ...", "Profile change: ...". */
  title: z.string(),
  /** The proposed reply, the post summary, or the names of the changed profile fields. */
  text: z.string(),
  /** Reply items: the review being answered (open /reviews?review=<reviewId>). */
  reviewId: z.string().nullable(),
  review: z
    .object({
      rating: z.number().int().nullable(),
      comment: z.string().nullable(),
      reviewerDisplayName: z.string().nullable(),
    })
    .nullable(),
  topicType: z.string().nullable(),
  /** Warnings you can approve in bulk only when warningsAcknowledged; change sets can never acknowledge. */
  guardrail: z.object({
    blocked: z.boolean(),
    warnings: z.number().int(),
    warningsAcknowledged: z.boolean(),
  }),
  provenance: z.object({
    /** ui, mcp, worker or cli: "mcp" means an agent drafted it. */
    createdSurface: z.string(),
    createdByName: z.string().nullable(),
  }),
  /** What the caller may do now; buttons come from these, never from the role. */
  can: z.object({ approve: z.boolean(), reject: z.boolean() }),
  /** The caller may discard it for good: posts.cancel (post), profile.cancel (changeset), posts.cancelEdit (postedit). Replies are never discardable. */
  canDiscard: z.boolean(),
});

export const approvalsQueue = defineAction({
  name: "approvals.queue",
  description:
    "Everything waiting for a person to approve, across the caller's workspaces or one workspaceId, oldest submission first: review replies, posts, profile change sets and edits of published posts with status pending_approval. Each item has a one-line title, the text, where it is for, who drafted it (provenance.createdSurface is mcp for an agent draft), a guardrail summary and can.approve / can.reject and canDiscard from the caller's role (canDiscard: act with posts.cancel, profile.cancel or posts.cancelEdit; replies have none), and locations (id, name, addressSummary) beside locationNames; act with reviewReplies.approve / reject, posts.approve / reject, profile.approve / reject, posts.approveEdit / rejectEdit (a postedit item's id is the edit id; the post stays published while its edit waits). An edit is included only while a live Google post it would patch is at an active location. counts are the totals before limit; truncated is true when limit cut the list. Replies at inactive locations are not included. A change set is included only while at least one location it changes is active, and only active locations are named.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    /** Narrow to these locations (a location scope). Items for other locations drop out and counts follow. */
    locationIds: z.array(z.uuid()).max(500).optional(),
    /** Narrow to the active locations of this group (a group scope), resolved here; instead of locationIds, not with it. */
    groupId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({
    items: z.array(itemOut),
    counts: countsOut,
    truncated: z.boolean(),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const narrow = narrowTo(actor, input);
    const [replies, postItems, sets, edits] = await Promise.all([
      pendingReplies(tx, actor, scope, input.workspaceId, narrow),
      pendingPosts(tx, actor, scope, input.workspaceId, narrow),
      pendingChangeSets(tx, actor, scope, input.workspaceId, narrow),
      pendingPostEdits(tx, actor, scope, input.workspaceId, narrow),
    ]);
    const all = [...replies, ...postItems, ...sets, ...edits].sort(bySubmitted);
    return {
      items: all.slice(0, input.limit),
      counts: approvalTotals({ reply: replies.length, post: postItems.length, changeset: sets.length, postedit: edits.length }),
      truncated: all.length > input.limit,
    };
  },
});

export const approvalsCounts = defineAction({
  name: "approvals.counts",
  description:
    "How many items wait for approval (replies, posts, profile change sets, post edits), across the caller's workspaces or one workspaceId. Count queries only: cheap enough to call on every page, unlike approvals.queue. Same scope and the same numbers as approvals.queue counts.",
  input: z.object({
    workspaceId: z.uuid().optional(),
    locationIds: z.array(z.uuid()).max(500).optional(),
    /** The active locations of this group, resolved here; instead of locationIds, not with it. */
    groupId: z.uuid().optional(),
  }),
  output: countsOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    return countPending(tx, actor, workspaceScope(actor), input.workspaceId, narrowTo(actor, input));
  },
});
