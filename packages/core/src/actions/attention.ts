import { z } from "zod";
import { authorize, workspaceScope } from "../actor";
import {
  approvalItems,
  autoApproveRules,
  byUrgency,
  changeItems,
  clientRows,
  countAttention,
  failedItems,
  lastReviewSyncAt,
  ownerCards,
  proposalItems,
  reviewItems,
  setupFacts,
} from "../attention";
import { defineAction } from "../registry";

const split = z.object({
  reply: z.number().int(),
  post: z.number().int(),
  changeset: z.number().int(),
  total: z.number().int(),
});
const approvalSplit = split.extend({
  /** Edits of published posts waiting for approval (the post stays published). */
  postedit: z.number().int(),
});
export const countsOut = z.object({
  approvals: approvalSplit,
  /** Reviews a person should answer now (reply policy applied; none already waiting for approval or failed). */
  reviews: z.object({ negative: z.number().int(), other: z.number().int(), total: z.number().int() }),
  /** Reviews whose reply is approved but not yet on Google (for example because Google writes are off). Nothing for a person to do, so it is not in total. */
  waitingToPublish: z.number().int(),
  /** Open profile changes (the Alerts page's "Open" count). */
  changes: z.number().int(),
  /** The caller's own pending, unexpired agent proposals. */
  proposals: z.number().int(),
  failed: split,
  total: z.number().int(),
  /** Reviews rated 1 to this are "negative". */
  negativeMaxStars: z.number().int(),
});

export const attentionCounts = defineAction({
  name: "attention.counts",
  description:
    "How many things need a person, across the caller's workspaces or one workspaceId, in disjoint buckets: approvals (replies, posts, profile change sets pending approval; the same numbers as approvals.counts), reviews to answer (negative = rated 1 to negativeMaxStars, other = higher or unrated; the workspace reply policy applies, and a review whose reply is already pending approval, approved or failed is not counted; the rule is the shared reply stage), waitingToPublish (reviews whose approved reply is not yet on Google; reported apart, not in total), open profile changes, the caller's own pending agent proposals (not narrowed by workspaceId), and failed publishes (replies, posts, change sets failed or partially applied). total is the sum. Count queries only: cheap enough for every page.",
  input: z.object({ workspaceId: z.uuid().optional() }),
  output: countsOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "review:read", { workspaceId: input.workspaceId });
    return (await countAttention(tx, actor, input.workspaceId, new Date())).counts;
  },
});

const kpi = z.object({ total: z.number(), deltaPct: z.number().nullable() });
const itemOut = z.object({
  kind: z.enum(["failed", "negative_review", "approval", "proposal", "change", "review"]),
  subject: z.enum(["reply", "post", "changeset", "postedit", "review", "change", "proposal"]),
  id: z.string(),
  reviewId: z.string().nullable(),
  locationId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  locationNames: z.array(z.string()),
  /** When it started waiting: submitted, review created, change found, proposal made, last failure. */
  at: z.string(),
  title: z.string(),
  /** Review text (clipped), or the token name of a proposal. */
  detail: z.string().nullable(),
  /** Failure reason code (google_writes_disabled, conflict, ...). */
  code: z.string().nullable(),
  rating: z.number().int().nullable(),
  replyStatus: z.enum(["draft", "blocked"]).nullable(),
  fields: z.array(z.string()),
  googleSuggested: z.boolean(),
  provenance: z.object({ createdSurface: z.string().nullable(), createdByName: z.string().nullable() }),
  expiresAt: z.string().nullable(),
});

export const attentionQueue = defineAction({
  name: "attention.queue",
  description:
    "Everything that needs a person, as one list sorted by urgency (failed publishes, negative reviews, approvals, your agent proposals, open profile changes, other reviews to answer; newest first within each), across the caller's workspaces or one workspaceId. Same buckets and counts as attention.counts; truncated is true when limit cut the list. Also returns what the Home page needs: activeLocations in the requested scope (Home shows its owner layout up to 3, the agency layout above), org-wide setup facts, locations that lost their Google connection (relink), per-client rows with an attention count and a 6-month rating trend, cards for up to 3 active locations with reviews, open changes, last post and 30-day calls and directions, the workspaces with an auto-approve rule, and when reviews last synced (UTC). Act on items with the action named by subject (reviewReplies.*, posts.*, profile.*, profile.changes.*, mcp.proposals.*).",
  input: z.object({
    workspaceId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    /** Active locations in the requested scope (workspaceId, else all the caller's). */
    activeLocations: z.number().int(),
    /** Org-wide (the caller's workspaces): the setup checklist ignores workspaceId. */
    setup: z.object({
      workspaces: z.number().int(),
      googleConnections: z.number().int(),
      locations: z.number().int(),
      activeLocations: z.number().int(),
      hasReviews: z.boolean(),
      hasPerformance: z.boolean(),
      /** Someone opened a location's health report (first-run checklist). */
      healthReportSeen: z.boolean(),
      /** An owner or admin hid the first-run checklist. */
      setupDismissed: z.boolean(),
      /** The organization has another member or any invitation. */
      teamInvited: z.boolean(),
      /** A workspace's time zone was derived from an address or saved by a person. */
      timeZoneSet: z.boolean(),
    }),
    relink: z.array(z.object({ workspaceId: z.string(), workspaceName: z.string(), locations: z.number().int() })),
    counts: countsOut,
    items: z.array(itemOut),
    truncated: z.boolean(),
    clients: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string(),
        activeLocations: z.number().int(),
        averageRating: z.number().nullable(),
        attention: z.number().int(),
        ratingTrend: z.array(z.number().nullable()),
      }),
    ),
    locations: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        addressSummary: z.string().nullable(),
        workspaceName: z.string(),
        reviews: z.object({ total: z.number(), avgRating: z.number().nullable(), unreplied: z.number(), waitingToPublish: z.number() }),
        openChanges: z.number(),
        suspensionOpen: z.boolean(),
        lastPostAt: z.string().nullable(),
        performance: z.object({ hasData: z.boolean(), calls: kpi, directions: kpi }),
      }),
    ),
    autoApprove: z.array(z.object({ workspaceName: z.string(), minStars: z.number().int() })),
    lastReviewSyncAt: z.string().nullable(),
  }),
  permission: "review:read",
  kind: "read",
  async handler(ctx, input) {
    const { tx, actor } = ctx;
    const ws = input.workspaceId;
    if (ws) authorize(actor, "review:read", { workspaceId: ws });
    const scope = workspaceScope(actor);
    const now = new Date();
    const lim = input.limit;
    const [{ byWs, counts }, facts, approvals, negative, other, changes, failed, proposals, autoApprove, synced] =
      await Promise.all([
        countAttention(tx, actor, ws, now),
        setupFacts(tx, actor, scope, ws),
        approvalItems(tx, actor, scope, ws),
        reviewItems(tx, actor, ws, "negative", lim),
        reviewItems(tx, actor, ws, "other", lim),
        changeItems(tx, actor, scope, ws, lim),
        failedItems(tx, actor, scope, ws, lim),
        proposalItems(ctx, lim),
        autoApproveRules(tx, actor, scope, ws),
        lastReviewSyncAt(tx, actor, scope, ws),
      ]);
    // Both are a few grouped queries; the page picks the layout, so 0C can pick it from its own scope.
    const [clients, cards] = await Promise.all([
      clientRows(tx, actor, scope, ws, byWs, now),
      ownerCards(tx, actor, scope, ws, now),
    ]);
    const items = [...failed, ...negative, ...approvals, ...proposals, ...changes, ...other].sort(byUrgency).slice(0, lim);
    return {
      ...facts,
      counts,
      items,
      truncated: items.length < counts.total,
      clients,
      locations: cards,
      autoApprove,
      lastReviewSyncAt: synced,
    };
  },
});
