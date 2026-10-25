import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, notifications, postEdits, posts } from "@opengmb/db";
import { GoogleApiError } from "./google/errors";
import { MockGoogleClient } from "./google/mock-client";
import { ReadOnlyGoogleClient } from "./google/read-only-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { POST_EDIT_QUEUE, processPostEdit } from "./posts/edit";
import { POST_SEND_QUEUE, processPostSend } from "./posts/jobs";
import { codeOf, makeKit, type Org } from "./testkit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const client = new ThrottledGoogleClient(mock, db);
const updates = () => mock.calls.filter((c) => c.method === "updateLocalPost");

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  await boss.start();
  await boss.createQueue(POST_SEND_QUEUE);
  await boss.createQueue(POST_EDIT_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  await boss.stop();
  await sql.end();
});

type Edit = {
  id: string;
  status: string;
  changedFields: string[];
  summary: string;
  results: { locationId: string; status: string; error: string | null }[];
  can: { approve: boolean; reject: boolean; cancel: boolean };
};
type Proposed = { outcome: string; code: string | null; edit: Edit | null };
type Post = {
  id: string;
  status: string;
  summary: string;
  cta: { actionType: string; url?: string | null } | null;
  targets: { id: string; locationId: string; googlePostName: string | null }[];
};

const tok = () => Math.random().toString(36).slice(2, 10).replace(/\d/g, "q");

/** A post published at the given locations (create, submit, approve, schedule now, worker send). */
async function published(org: Org, locationIds: string[], over: Record<string, unknown> = {}) {
  const { post } = await kit.run<{ post: Post }>(org.manager, "posts.createDraft", {
    workspaceId: org.a,
    locationIds,
    topicType: "STANDARD",
    summary: `Spring checkup week ${tok()}.`,
    ...over,
  });
  await kit.run(org.manager, "posts.submit", { id: post.id, acknowledgeWarnings: true });
  await kit.run(org.approverA, "posts.approve", { id: post.id });
  await kit.run(org.manager, "posts.schedule", { id: post.id });
  await processPostSend(db, { postId: post.id, occurrence: 0 }, { client });
  const got = await kit.run<{ post: Post }>(org.owner, "posts.get", { id: post.id });
  expect(got.post.status).toBe("published");
  return got.post;
}
const propose = (org: Org, id: string, input: Record<string, unknown>) =>
  kit.run<Proposed>(org.manager, "posts.proposeEdit", { id, acknowledgeWarnings: true, ...input });
const rowOf = async (id: string) => (await db.select().from(posts).where(eq(posts.id, id)))[0]!;

describe("P1: editing a published post goes through approval", () => {
  it("sends nothing before approval, then patches each live post with the right updateMask", async () => {
    const org = await kit.makeOrg();
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const post = await published(org, [l1.row.id, l2.row.id], {
      cta: { actionType: "LEARN_MORE", url: "https://example.test/spring" },
    });
    const text = `New spring hours ${tok()}.`;
    const p = await propose(org, post.id, { summary: text });
    expect(p.outcome).toBe("pending_approval");
    expect(p.edit!.changedFields).toEqual(["summary"]);
    expect(p.edit!.status).toBe("pending_approval");

    // Before approval: the worker refuses, Google is not called, the post is unchanged.
    const before = updates().length;
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client })).toBeNull();
    expect(updates().length).toBe(before);
    expect((await rowOf(post.id)).summary).toBe(post.summary);

    // Approval is what lets it through, and it needs the approve permission.
    expect(await codeOf(kit.run(org.viewerA, "posts.approveEdit", { id: p.edit!.id }))).toBe(
      "FORBIDDEN",
    );
    const ok = await kit.run<{ edit: Edit }>(org.approverA, "posts.approveEdit", {
      id: p.edit!.id,
    });
    expect(ok.edit.status).toBe("applying");
    expect(updates().length).toBe(before); // approving only queues the job
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client })).toBe("applied");

    const calls = updates().slice(before);
    expect(calls.map((c) => c.args[0]).sort()).toEqual(post.targets.map((t) => t.googlePostName).sort());
    for (const c of calls) {
      expect(c.args[2]).toEqual(["summary"]);
      expect(c.args[1]).toMatchObject({ summary: text, topicType: "STANDARD" });
    }
    const after = await rowOf(post.id);
    expect(after.summary).toBe(text);
    const got = await kit.run<{ edit: Edit; canPropose: boolean }>(org.owner, "posts.editGet", {
      id: post.id,
    });
    expect(got.edit!.status).toBe("applied");
    expect(got.edit!.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(got.canPropose).toBe(true);
    // A second run does nothing: the edit is no longer applying.
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client })).toBeNull();
    expect(updates().length).toBe(before + 2);
  });

  it("masks only what changed, and clearing a field names it in the mask but leaves it out of the body", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const post = await published(org, [loc.row.id], {
      cta: { actionType: "LEARN_MORE", url: "https://example.test/spring" },
    });
    const p = await propose(org, post.id, { cta: null });
    expect(p.edit!.changedFields).toEqual(["callToAction"]);
    await kit.run(org.approverA, "posts.approveEdit", { id: p.edit!.id });
    const before = updates().length;
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client })).toBe("applied");
    const [call] = updates().slice(before);
    expect(call!.args[2]).toEqual(["callToAction"]);
    expect(call!.args[1]).not.toHaveProperty("callToAction");
    expect((await rowOf(post.id)).cta).toBeNull();
  });

  it("refuses what cannot be edited", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const { post: draft } = await kit.run<{ post: Post }>(org.manager, "posts.createDraft", {
      workspaceId: org.a,
      locationIds: [loc.row.id],
      topicType: "STANDARD",
      summary: `Draft ${tok()}.`,
    });
    expect(await codeOf(propose(org, draft.id, { summary: "x" }))).toBe("CONFLICT");

    const post = await published(org, [loc.row.id]);
    expect(await codeOf(propose(org, post.id, { summary: post.summary }))).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        kit.run(org.viewerA, "posts.proposeEdit", { id: post.id, summary: `Other ${tok()}.` }),
      ),
    ).toBe("FORBIDDEN");

    const blocked = await propose(org, post.id, { summary: "Call 713-555-0142 now." });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.edit).toBeNull();

    const first = await propose(org, post.id, { summary: `One ${tok()}.` });
    expect(first.outcome).toBe("pending_approval");
    expect(await codeOf(propose(org, post.id, { summary: `Two ${tok()}.` }))).toBe("CONFLICT");

    // Rejected: never reaches Google.
    const before = updates().length;
    await kit.run(org.approverA, "posts.rejectEdit", { id: first.edit!.id, reason: "Not yet" });
    expect(await processPostEdit(db, { editId: first.edit!.id }, { client })).toBeNull();
    expect(updates().length).toBe(before);
    // A rejected edit frees the post for a new one, which can be withdrawn.
    const again = await propose(org, post.id, { summary: `Three ${tok()}.` });
    const gone = await kit.run<{ edit: Edit }>(org.manager, "posts.cancelEdit", { id: again.edit!.id });
    expect(gone.edit.status).toBe("cancelled");
    expect(await processPostEdit(db, { editId: again.edit!.id }, { client })).toBeNull();
  });

  it("a client approver sees and approves only their own workspace's edits", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const post = await published(org, [loc.row.id]);
    const p = await propose(org, post.id, { summary: `Own ${tok()}.` });
    expect(await codeOf(kit.run(org.approverB, "posts.approveEdit", { id: p.edit!.id }))).toBe(
      "NOT_FOUND",
    );
  });

  it("a proposed edit notifies that workspace's client approvers, with a link to the portal edit page", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const post = await published(org, [loc.row.id]);
    const p = await propose(org, post.id, { summary: `Notify ${tok()}.` });
    const mine = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, org.approverA.userId), eq(notifications.kind, "approval.requested")));
    const forEdit = mine.filter((n) => n.link === `/portal/approvals/postedit/${p.edit!.id}`);
    expect(forEdit).toHaveLength(1);
    expect(forEdit[0]!.title).toMatch(/^Post edit awaiting your approval for /);
    const other = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, org.approverB.userId), eq(notifications.kind, "approval.requested")));
    expect(other.filter((n) => n.link?.includes(p.edit!.id))).toHaveLength(0);
  });

  it("with Google writes off the edit fails per location and the post keeps its text", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const post = await published(org, [loc.row.id]);
    const p = await propose(org, post.id, { summary: `Off ${tok()}.` });
    await kit.run(org.approverA, "posts.approveEdit", { id: p.edit!.id });
    const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client: readOnly })).toBe("failed");
    const [edit] = await db.select().from(postEdits).where(eq(postEdits.id, p.edit!.id));
    expect(edit!.results).toMatchObject([{ status: "failed", error: "google_writes_disabled" }]);
    expect((await rowOf(post.id)).summary).toBe(post.summary);
  });

  it("one location failing does not stop the other; the edit is partly applied", async () => {
    const org = await kit.makeOrg();
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const post = await published(org, [l1.row.id, l2.row.id]);
    const text = `Partly ${tok()}.`;
    const p = await propose(org, post.id, { summary: text });
    await kit.run(org.approverA, "posts.approveEdit", { id: p.edit!.id });
    mock.failNext(1, () => new GoogleApiError(403, {}), "updateLocalPost");
    expect(await processPostEdit(db, { editId: p.edit!.id }, { client })).toBe("partly_applied");
    const [edit] = await db.select().from(postEdits).where(eq(postEdits.id, p.edit!.id));
    expect((edit!.results as { status: string; error?: string }[]).map((r) => r.status).sort()).toEqual(["applied", "failed"]);
    expect((await rowOf(post.id)).summary).toBe(text);
  });
});
