import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  notifications,
  organizations,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOTE = "patient Jane Roe called about her knee surgery";
const run = (actor: Actor, name: string, input: unknown = {}) => executeAction(db, actor, name, input);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}

async function setup() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
  const mk = async (role: "owner" | "manager" | "client_approver" | "client_viewer", name: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name, email: `${id}@example.test` });
    await db
      .insert(memberships)
      .values({ orgId, userId: id, role, workspaceId: role.startsWith("client") ? ws!.id : undefined });
    return { id, email: `${id}@example.test`, actor: await loadActor(db, { userId: id, surface: "ui", actorType: "user" }) };
  };
  const owner = await mk("owner", "Olive Owner");
  const manager = await mk("manager", "Manny Manager");
  const viewer = await mk("client_viewer", "Vic Viewer");
  const approver = await mk("client_approver", "Ann Approver");
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  const n = `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
  const [loc] = await db
    .insert(locations)
    .values({
      orgId,
      workspaceId: ws!.id,
      name: "Main Clinic",
      googleAccountName: `accounts/9${n.slice(-8)}`,
      googleLocationId: `locations/9${n.slice(-10)}`,
      connectionId,
      status: "active",
    })
    .returning();
  const review = async (o: { reply?: string } = {}) => {
    const t = new Date("2026-09-01T00:00:00Z");
    const [r] = await db
      .insert(reviews)
      .values({
        orgId,
        workspaceId: ws!.id,
        locationId: loc!.id,
        googleReviewName: `accounts/1/locations/1/reviews/t${uniq()}`,
        starRating: 2,
        comment: "slow service",
        createTime: t,
        updateTime: t,
        replyComment: o.reply ?? null,
      })
      .returning();
    return r!;
  };
  return { orgId, ws: ws!.id, owner, manager, viewer, approver, review };
}

type Assigned = { assignment: { assigneeUserId: string; dueAt: string | null; overdue: boolean } | null };

describe("R6 assign reviews and internal notes", () => {
  it("assigns with a due date and a note, notifies the assignee, and audits without the note text", async () => {
    const t = await setup();
    const r = await t.review();
    const due = "2026-12-01T10:00:00.000Z";
    const out = (await run(t.owner.actor, "reviews.assign", {
      reviewId: r.id,
      assigneeUserId: t.manager.id,
      dueAt: due,
      note: NOTE,
    })) as Assigned;
    expect(out.assignment).toMatchObject({ assigneeUserId: t.manager.id, dueAt: due, overdue: false });

    const notes = (await run(t.owner.actor, "reviewNotes.list", { reviewId: r.id })) as { notes: { body: string; authorName: string }[] };
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({ body: NOTE, authorName: "Olive Owner" });

    const ns = await db.select().from(notifications).where(eq(notifications.userId, t.manager.id));
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ kind: "review.assigned", link: `/reviews?review=${r.id}` });
    expect(ns[0]!.title).toContain("Main Clinic");

    // The note text and the review text never reach a notification or an audit row.
    const audits = await db.select().from(auditLog).where(eq(auditLog.orgId, t.orgId));
    const blob = JSON.stringify([ns, audits]);
    expect(blob).not.toContain("Jane Roe");
    expect(blob).not.toContain("slow service");
    expect(audits.some((a) => a.action === "review.assign")).toBe(true);

    const list = (await run(t.manager.actor, "reviews.assignments", { reviewIds: [r.id] })) as {
      items: { reviewId: string; noteCount: number; assignment: { assigneeName: string } | null }[];
    };
    expect(list.items).toEqual([
      expect.objectContaining({ reviewId: r.id, noteCount: 1, assignment: expect.objectContaining({ assigneeName: "Manny Manager" }) }),
    ]);
  });

  it("does not notify on self-assignment; reassign replaces; unassign removes", async () => {
    const t = await setup();
    const r = await t.review();
    await run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: t.owner.id });
    expect(await db.select().from(notifications).where(eq(notifications.userId, t.owner.id))).toHaveLength(0);
    await run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: t.manager.id });
    const list = (await run(t.owner.actor, "reviews.assignments", { reviewIds: [r.id] })) as { items: { assignment: { assigneeUserId: string } | null }[] };
    expect(list.items[0]!.assignment!.assigneeUserId).toBe(t.manager.id);
    await run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: null });
    expect(((await run(t.owner.actor, "reviews.assignments", { reviewIds: [r.id] })) as { items: unknown[] }).items).toEqual([]);
  });

  it("only org-wide staff are assignable; client roles are not", async () => {
    const t = await setup();
    const r = await t.review();
    for (const bad of [t.viewer.id, t.approver.id, "nobody"]) {
      expect(await codeOf(run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: bad }))).toBe("INVALID_INPUT");
    }
    const { assignees } = (await run(t.owner.actor, "reviews.assignees", { workspaceId: t.ws })) as { assignees: { userId: string }[] };
    expect(assignees.map((a) => a.userId).sort()).toEqual([t.manager.id, t.owner.id].sort());
  });

  it("client roles cannot assign, list assignments, or read or write notes, and see no notes anywhere", async () => {
    const t = await setup();
    const r = await t.review();
    await run(t.owner.actor, "reviewNotes.add", { reviewId: r.id, body: NOTE });
    await run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: t.manager.id, note: NOTE });
    for (const c of [t.viewer.actor, t.approver.actor]) {
      expect(await codeOf(run(c, "reviews.assign", { reviewId: r.id, assigneeUserId: t.manager.id }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviews.assignees", { workspaceId: t.ws }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviews.assignments", { reviewIds: [r.id] }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviewNotes.list", { reviewId: r.id }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviewNotes.add", { reviewId: r.id, body: "x" }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviews.list", { assignedToMe: true }))).toBe("FORBIDDEN");
      expect(await codeOf(run(c, "reviews.list", { overdue: true }))).toBe("FORBIDDEN");
      // What clients can read carries neither note nor assignee.
      const seen = JSON.stringify([
        await run(c, "reviews.list", {}),
        await run(c, "reviews.get", { id: r.id }),
        await run(c, "reviews.export", {}),
      ]);
      expect(seen).not.toContain("Jane Roe");
      expect(seen).not.toContain(t.manager.id);
    }
  });

  it("a review of another organization is NOT_FOUND", async () => {
    const t = await setup();
    const other = await setup();
    const r = await other.review();
    expect(await codeOf(run(t.owner.actor, "reviews.assign", { reviewId: r.id, assigneeUserId: t.manager.id }))).toBe("NOT_FOUND");
    expect(await codeOf(run(t.owner.actor, "reviewNotes.add", { reviewId: r.id, body: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(run(t.owner.actor, "reviewNotes.list", { reviewId: r.id }))).toBe("NOT_FOUND");
  });

  it("filters: assigned to me, and overdue (due passed and still needs a reply)", async () => {
    const t = await setup();
    const mine = await t.review();
    const other = await t.review();
    const late = await t.review();
    const lateButReplied = await t.review({ reply: "Thanks" });
    const past = "2020-01-01T00:00:00.000Z";
    await run(t.owner.actor, "reviews.assign", { reviewId: mine.id, assigneeUserId: t.manager.id });
    await run(t.owner.actor, "reviews.assign", { reviewId: other.id, assigneeUserId: t.owner.id });
    await run(t.owner.actor, "reviews.assign", { reviewId: late.id, assigneeUserId: t.owner.id, dueAt: past });
    await run(t.owner.actor, "reviews.assign", { reviewId: lateButReplied.id, assigneeUserId: t.owner.id, dueAt: past });
    const ids = async (a: Actor, f: object) =>
      ((await run(a, "reviews.list", f)) as { items: { id: string }[] }).items.map((i) => i.id).sort();
    expect(await ids(t.manager.actor, { assignedToMe: true })).toEqual([mine.id]);
    expect(await ids(t.owner.actor, { assignedToMe: true })).toEqual([other.id, late.id, lateButReplied.id].sort());
    expect(await ids(t.owner.actor, { overdue: true })).toEqual([late.id]);
    const a = (await run(t.owner.actor, "reviews.assignments", { reviewIds: [late.id, lateButReplied.id] })) as { items: { reviewId: string; assignment: { overdue: boolean } }[] };
    expect(Object.fromEntries(a.items.map((i) => [i.reviewId, i.assignment.overdue]))).toEqual({ [late.id]: true, [lateButReplied.id]: false });
  });
});
