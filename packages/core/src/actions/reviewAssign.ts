import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  memberships,
  notifications,
  reviewAssignments,
  reviewNotes,
  reviews,
  users,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { getReviewRow, scopeConditions } from "../reviews/queries";
import { NEEDS_YOU_STAGES, replyStageSql } from "../reviews/reply-stage";

export const REVIEW_ASSIGNED_KIND = "review.assigned";
export const NOTE_MAX = 2000;
const isoDate = z.iso.datetime({ offset: true });

/** Org-wide staff roles. Client roles belong to one workspace and are never assignable. */
const STAFF_ROLES = ["owner", "admin", "manager"] as const;

const assignmentOut = z.object({
  assigneeUserId: z.string(),
  assigneeName: z.string(),
  assignedBy: z.string(),
  dueAt: z.string().nullable(),
  assignedAt: z.string(),
  overdue: z.boolean(),
});

const noteOut = z.object({
  id: z.string(),
  authorUserId: z.string(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

async function visibleReview(tx: Tx, actor: Actor, id: string) {
  const row = await getReviewRow(tx, actor, id);
  if (!row) throw new AccessError("NOT_FOUND", "Review not found");
  authorize(actor, "review:draft", { workspaceId: row.workspaceId });
  return row;
}

function toAssignment(
  a: typeof reviewAssignments.$inferSelect,
  name: string,
  needsYou: boolean,
): z.input<typeof assignmentOut> {
  return {
    assigneeUserId: a.assigneeUserId,
    assigneeName: name,
    assignedBy: a.assignedBy,
    dueAt: a.dueAt?.toISOString() ?? null,
    assignedAt: a.assignedAt.toISOString(),
    overdue: a.dueAt !== null && a.dueAt.getTime() < Date.now() && needsYou,
  };
}

const NEEDS_YOU: readonly string[] = NEEDS_YOU_STAGES;

export const reviewsAssignees = defineAction({
  name: "reviews.assignees",
  description:
    "Team members a review in this workspace can be assigned to: the organization-wide members (owner, admin, manager). Client roles are never listed. Needs review:draft.",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({
    assignees: z.array(z.object({ userId: z.string(), name: z.string(), role: z.enum(STAFF_ROLES) })),
  }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:draft", { workspaceId: input.workspaceId });
    const [w] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
    const rows = await tx
      .select({ userId: memberships.userId, name: users.name, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.orgId, actor.orgId),
          isNull(memberships.workspaceId),
          inArray(memberships.role, [...STAFF_ROLES]),
        ),
      )
      .orderBy(asc(users.name), asc(users.id));
    return {
      assignees: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        role: r.role as (typeof STAFF_ROLES)[number],
      })),
    };
  },
});

export const reviewsAssign = defineAction({
  name: "reviews.assign",
  description:
    "Assign a review to a team member (an organization-wide owner, admin or manager; client roles cannot be assigned), with an optional due date (ISO datetime; omitted clears it) and an optional internal note added in the same step. Assigning again replaces the assignee and due date. assigneeUserId null removes the assignment. The assignee gets an in-app notification (and the daily email digest when email is configured) unless they assigned it to themselves. The notification names the location only, never the review or the note. Internal only: nothing here reaches Google or a reply. Needs review:draft.",
  input: z.object({
    reviewId: z.uuid(),
    assigneeUserId: z.string().min(1).nullable(),
    dueAt: isoDate.nullable().optional(),
    note: z.string().trim().min(1).max(NOTE_MAX).optional(),
  }),
  output: z.object({ assignment: assignmentOut.nullable() }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const review = await visibleReview(tx, actor, input.reviewId);
    const needsYou = NEEDS_YOU.includes(review.replyStage);
    const [before] = await tx
      .select({ assigneeUserId: reviewAssignments.assigneeUserId, dueAt: reviewAssignments.dueAt })
      .from(reviewAssignments)
      .where(eq(reviewAssignments.reviewId, review.id));

    let assignment: z.input<typeof assignmentOut> | null = null;
    if (input.assigneeUserId === null) {
      await tx.delete(reviewAssignments).where(eq(reviewAssignments.reviewId, review.id));
    } else {
      const [assignee] = await tx
        .select({ userId: memberships.userId, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.orgId, actor.orgId),
            eq(memberships.userId, input.assigneeUserId),
            isNull(memberships.workspaceId),
            inArray(memberships.role, [...STAFF_ROLES]),
          ),
        );
      if (!assignee) {
        throw new CoreError(
          "INVALID_INPUT",
          "Only an owner, admin or manager of this organization can be assigned a review",
        );
      }
      const assignedAt = new Date();
      const dueAt = input.dueAt ? new Date(input.dueAt) : null;
      const [row] = await tx
        .insert(reviewAssignments)
        .values({
          orgId: actor.orgId,
          workspaceId: review.workspaceId,
          reviewId: review.id,
          assigneeUserId: assignee.userId,
          assignedBy: actor.userId,
          dueAt,
          assignedAt,
        })
        .onConflictDoUpdate({
          target: reviewAssignments.reviewId,
          set: { assigneeUserId: assignee.userId, assignedBy: actor.userId, dueAt, assignedAt },
        })
        .returning();
      assignment = toAssignment(row!, assignee.name, needsYou);
      if (assignee.userId !== actor.userId) {
        const [loc] = await tx
          .select({ name: locations.name })
          .from(locations)
          .where(eq(locations.id, review.locationId));
        await tx
          .insert(notifications)
          .values({
            orgId: actor.orgId,
            userId: assignee.userId,
            kind: REVIEW_ASSIGNED_KIND,
            title: `A review at ${loc?.name ?? "a location"} was assigned to you`,
            link: `/reviews?review=${review.id}`,
            sourceType: "review_assignment",
            sourceId: `${review.id}:${assignedAt.toISOString()}`,
          })
          .onConflictDoNothing({
            target: [notifications.userId, notifications.sourceType, notifications.sourceId],
          });
      }
    }
    if (input.note) {
      await tx.insert(reviewNotes).values({
        orgId: actor.orgId,
        workspaceId: review.workspaceId,
        reviewId: review.id,
        authorUserId: actor.userId,
        body: input.note,
      });
    }
    // Ids and dates only: a note can name a patient, so its text never goes into an audit row.
    await audit({
      action: input.assigneeUserId === null ? "review.unassign" : "review.assign",
      entityType: "review",
      entityId: review.id,
      before: before
        ? { assigneeUserId: before.assigneeUserId, dueAt: before.dueAt?.toISOString() ?? null }
        : null,
      after:
        input.assigneeUserId === null
          ? { assigneeUserId: null, hasNote: Boolean(input.note) }
          : {
              assigneeUserId: input.assigneeUserId,
              dueAt: assignment?.dueAt ?? null,
              hasNote: Boolean(input.note),
            },
    });
    return { assignment };
  },
});

export const reviewsAssignments = defineAction({
  name: "reviews.assignments",
  description:
    "Who each of up to 100 reviews is assigned to, with the due date, whether it is overdue (due date passed and the review still needs a reply) and how many internal notes it has. Reviews with neither an assignment nor a note are left out. Only reviews the caller can see are considered. Needs review:draft: client roles never see assignments.",
  input: z.object({ reviewIds: z.array(z.uuid()).min(1).max(100) }),
  output: z.object({
    items: z.array(
      z.object({
        reviewId: z.string(),
        assignment: assignmentOut.nullable(),
        noteCount: z.number().int(),
      }),
    ),
  }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:draft");
    const visible = await tx
      .select({ id: reviews.id, stage: replyStageSql })
      .from(reviews)
      .innerJoin(locations, eq(locations.id, reviews.locationId))
      .where(and(...scopeConditions(actor), inArray(reviews.id, input.reviewIds)));
    const ids = visible.map((v) => v.id);
    if (ids.length === 0) return { items: [] };
    const stage = new Map(visible.map((v) => [v.id, v.stage as string]));
    const assigned = await tx
      .select({ a: reviewAssignments, name: users.name })
      .from(reviewAssignments)
      .innerJoin(users, eq(users.id, reviewAssignments.assigneeUserId))
      .where(and(eq(reviewAssignments.orgId, actor.orgId), inArray(reviewAssignments.reviewId, ids)));
    const counts = await tx
      .select({ reviewId: reviewNotes.reviewId, n: sql<number>`count(*)::int` })
      .from(reviewNotes)
      .where(and(eq(reviewNotes.orgId, actor.orgId), inArray(reviewNotes.reviewId, ids)))
      .groupBy(reviewNotes.reviewId);
    const countOf = new Map(counts.map((c) => [c.reviewId, c.n]));
    const byReview = new Map(assigned.map((r) => [r.a.reviewId, r]));
    return {
      items: ids
        .filter((id) => byReview.has(id) || countOf.has(id))
        .sort()
        .map((id) => {
          const r = byReview.get(id);
          return {
            reviewId: id,
            assignment: r ? toAssignment(r.a, r.name, NEEDS_YOU.includes(stage.get(id) ?? "")) : null,
            noteCount: countOf.get(id) ?? 0,
          };
        }),
    };
  },
});

export const reviewNotesAdd = defineAction({
  name: "reviewNotes.add",
  description:
    "Add an internal note to a review (up to 2000 characters). Notes are for the team only: they are never sent to Google, never part of a reply, and client roles cannot see them. The audit entry records that a note was added, not its text. Needs review:draft.",
  input: z.object({ reviewId: z.uuid(), body: z.string().trim().min(1).max(NOTE_MAX) }),
  output: z.object({ note: noteOut }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const review = await visibleReview(tx, actor, input.reviewId);
    const [row] = await tx
      .insert(reviewNotes)
      .values({
        orgId: actor.orgId,
        workspaceId: review.workspaceId,
        reviewId: review.id,
        authorUserId: actor.userId,
        body: input.body,
      })
      .returning();
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
    await audit({
      action: "review.note_add",
      entityType: "review",
      entityId: review.id,
      before: null,
      after: { noteId: row!.id, length: input.body.length },
    });
    return {
      note: {
        id: row!.id,
        authorUserId: actor.userId,
        authorName: me?.name ?? "",
        body: row!.body,
        createdAt: row!.createdAt.toISOString(),
      },
    };
  },
});

export const reviewNotesList = defineAction({
  name: "reviewNotes.list",
  description:
    "The internal notes on a review, oldest first, with who wrote each. Team only (needs review:draft): client roles never see notes.",
  input: z.object({ reviewId: z.uuid() }),
  output: z.object({ notes: z.array(noteOut) }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    const review = await visibleReview(tx, actor, input.reviewId);
    const rows = await tx
      .select({ n: reviewNotes, name: users.name })
      .from(reviewNotes)
      .innerJoin(users, eq(users.id, reviewNotes.authorUserId))
      .where(and(eq(reviewNotes.orgId, actor.orgId), eq(reviewNotes.reviewId, review.id)))
      .orderBy(asc(reviewNotes.createdAt), asc(reviewNotes.id));
    return {
      notes: rows.map(({ n, name }) => ({
        id: n.id,
        authorUserId: n.authorUserId,
        authorName: name,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  },
});
