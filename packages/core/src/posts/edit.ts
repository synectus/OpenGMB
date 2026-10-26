import { and, asc, eq } from "drizzle-orm";
import { isOrgBlocked } from "../account-state";
import { deferBlockedJob } from "../jobs";
import { locations, postEdits, postTargets, posts, type Db, type Tx } from "@opengmb/db";
import { assertPassed, guardrailSubject, runGuardrails, type GuardrailResult } from "../guardrails";
import { clientFor, googleFailure } from "../reviews/reply-jobs";
import { workerAudit } from "../reviews/reply-state";
import { contentFromRow, postAuditFields, type EditField, type PostContent, type PostRow } from "./content";
import { buildPostGuardrailContext } from "./context";
import { updatePublishedPost, type PostWriter } from "./publish";

export const POST_EDIT_QUEUE = "posts.editGoogle";
export type PostEditJob = { editId: string };
export type PostEditRow = typeof postEdits.$inferSelect;
export type PostEditStatus = PostEditRow["status"];
export type PostEditResult = {
  targetId: string;
  locationId: string;
  status: "applied" | "failed";
  error?: string;
};

/** The post's content with the edit's editable fields laid over it. Topic type and alert type never change. */
export function contentWithEdit(post: PostRow, edit: PostEditRow): PostContent {
  return {
    ...contentFromRow(post),
    summary: edit.summary,
    cta: (edit.cta as PostContent["cta"]) ?? null,
    event: (edit.event as PostContent["event"]) ?? null,
    offer: (edit.offer as PostContent["offer"]) ?? null,
    media: (edit.media as PostContent["media"]) ?? [],
  };
}

/** What an audit row may say about an edit: ids, status, changed field names, counts, rule ids. Never the text. */
export function editAuditFields(
  post: PostRow,
  edit: PostEditRow,
  guardrail?: GuardrailResult | null,
): Record<string, unknown> {
  return {
    editId: edit.id,
    revision: edit.revision,
    changedFields: edit.changedFields,
    ...postAuditFields({ ...post, ...contentWithEdit(post, edit) }, guardrail),
  };
}

/** The published targets an edit patches: the post's latest occurrence, still on Google. */
export async function editableTargets(tx: Tx, post: PostRow) {
  return tx
    .select()
    .from(postTargets)
    .where(
      and(
        eq(postTargets.postId, post.id),
        eq(postTargets.occurrence, post.occurrence),
        eq(postTargets.status, "published"),
      ),
    )
    .orderBy(asc(postTargets.createdAt), asc(postTargets.id))
    .then((rows) => rows.filter((t) => t.googlePostName));
}

const REASONS = {
  inactive: "location_inactive",
  unlinked: "location_not_linked_to_google",
  noConnection: "connection_removed",
  warnings: "warnings_require_acknowledgement",
  unexpected: "unexpected_error",
} as const;

type Prepared =
  | { kind: "gone" }
  | { kind: "fail"; error: string }
  | {
      kind: "send";
      connectionId: string | null;
      content: PostContent;
      passed: ReturnType<typeof assertPassed>;
    };

/**
 * Worker side of an approved edit (`posts.approveEdit`). Does nothing unless the edit is
 * `applying`: a pending, rejected or cancelled edit never reaches Google. For each published
 * target, in order, mirroring `processPostSend`:
 *   1. one short transaction: rebuild THIS location's guardrail context and run the guardrails on
 *      the edited content again (a block, or unacknowledged warnings, fails that target);
 *   2. no transaction: `updatePublishedPost` (needs the branded GuardrailPassed for exactly this
 *      content) through the throttled client, which refuses writes unless GOOGLE_BUSINESS_WRITES
 *      allows them; the patch names only the changed fields in its updateMask;
 *   3. one short transaction: the result is appended to `post_edits.results` and audited.
 * Google 4xx/429 and refused writes fail only that target; other errors leave it unrecorded and the
 * job throws so pg-boss retries (a target already recorded is skipped, and the idempotency key
 * stops a second patch). Then the edit is finalised: applied (all locations), partly_applied or
 * failed. If any location was patched, the post's own row takes the new text so the app shows what
 * is live; locations that failed keep the old text on Google, listed in the results.
 */
export async function processPostEdit(
  db: Db,
  job: PostEditJob,
  deps: { client?: PostWriter; isFinalAttempt?: boolean } = {},
): Promise<PostEditStatus | null> {
  const loaded = await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(postEdits).where(eq(postEdits.id, job.editId));
    if (!edit || edit.status !== "applying") return null;
    const [post] = await tx.select().from(posts).where(eq(posts.id, edit.postId));
    if (!post) return null;
    // AP3b: suspended or deleted. The edit stays `applying`; the job is re-queued for later.
    if (await isOrgBlocked(tx, post.orgId)) {
      await deferBlockedJob(tx, POST_EDIT_QUEUE, job, post.orgId);
      return null;
    }
    return { edit, post, targets: await editableTargets(tx, post) };
  });
  if (!loaded) return null;
  const { edit, post } = loaded;
  const done = new Set((edit.results as PostEditResult[]).map((r) => r.targetId));
  const changed = edit.changedFields as EditField[];

  let unexpected: unknown = null;
  const clients = new Map<string, PostWriter | null>();
  for (const t of loaded.targets) {
    if (done.has(t.id)) continue;
    const prepared = await db.transaction(async (tx): Promise<Prepared> => {
      const [cur] = await tx.select().from(postEdits).where(eq(postEdits.id, edit.id));
      if (!cur || cur.status !== "applying") return { kind: "gone" };
      if (await isOrgBlocked(tx, post.orgId)) {
        await deferBlockedJob(tx, POST_EDIT_QUEUE, job, post.orgId);
        return { kind: "gone" };
      }
      const [loc] = await tx.select().from(locations).where(eq(locations.id, t.locationId));
      if (!loc || loc.status !== "active") return { kind: "fail", error: REASONS.inactive };
      if (!loc.googleAccountName || !loc.googleLocationId) {
        return { kind: "fail", error: REASONS.unlinked };
      }
      const content = contentWithEdit(post, cur);
      const ctx = await buildPostGuardrailContext(tx, {
        workspaceId: post.workspaceId,
        locationId: loc.id,
        content,
      });
      if (!ctx) return { kind: "fail", error: REASONS.inactive };
      const result = runGuardrails(ctx);
      if (!result.ok) {
        const ids = [
          ...new Set(result.violations.filter((v) => v.severity === "block").map((v) => v.ruleId)),
        ];
        return { kind: "fail", error: `guardrail_blocked:${ids.join(",")}` };
      }
      if (result.violations.length > 0 && !cur.warningsAcknowledged) {
        return { kind: "fail", error: REASONS.warnings };
      }
      return {
        kind: "send",
        connectionId: loc.connectionId,
        content,
        passed: assertPassed(result, guardrailSubject(ctx)),
      };
    });
    if (prepared.kind === "gone") break;
    if (prepared.kind === "fail") {
      await record(db, edit.id, t, { status: "failed", error: prepared.error });
      continue;
    }

    const key = prepared.connectionId ?? "";
    if (!deps.client && !clients.has(key)) {
      clients.set(key, await clientFor(db, t.orgId, prepared.connectionId));
    }
    const client = deps.client ?? clients.get(key) ?? null;
    if (!client) {
      await record(db, edit.id, t, { status: "failed", error: REASONS.noConnection });
      continue;
    }
    try {
      await updatePublishedPost(
        client,
        {
          orgId: t.orgId,
          targetId: t.id,
          postName: t.googlePostName!,
          revision: edit.revision,
          changed,
        },
        prepared.content,
        prepared.passed,
      );
      await record(db, edit.id, t, { status: "applied" });
    } catch (e) {
      const reason = googleFailure(e);
      if (reason) await record(db, edit.id, t, { status: "failed", error: reason });
      else if (deps.isFinalAttempt) {
        await record(db, edit.id, t, { status: "failed", error: REASONS.unexpected });
      } else unexpected ??= e;
    }
  }
  if (unexpected) throw unexpected;
  return finalizeEdit(db, edit.id);
}

/** Append one target's result to the edit and audit it, in one short transaction. */
async function record(
  db: Db,
  editId: string,
  t: { id: string; orgId: string; locationId: string },
  outcome: { status: "applied" | "failed"; error?: string },
) {
  await db.transaction(async (tx) => {
    const [edit] = await tx.select().from(postEdits).where(eq(postEdits.id, editId)).for("update");
    if (!edit || edit.status !== "applying") return;
    const results = edit.results as PostEditResult[];
    if (results.some((r) => r.targetId === t.id)) return;
    const [post] = await tx.select().from(posts).where(eq(posts.id, edit.postId));
    if (!post) return;
    await tx
      .update(postEdits)
      .set({
        results: [...results, { targetId: t.id, locationId: t.locationId, ...outcome }],
        updatedAt: new Date(),
      })
      .where(eq(postEdits.id, edit.id));
    await workerAudit(
      tx,
      t.orgId,
    )({
      action: `post.target_edit_${outcome.status}`,
      entityType: "post_target",
      entityId: t.id,
      before: { editStatus: "applying" },
      after: {
        locationId: t.locationId,
        ...editAuditFields(post, edit),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });
  });
}

async function finalizeEdit(db: Db, editId: string): Promise<PostEditStatus | null> {
  return db.transaction(async (tx) => {
    const [edit] = await tx.select().from(postEdits).where(eq(postEdits.id, editId)).for("update");
    if (!edit || edit.status !== "applying") return edit?.status ?? null;
    const [post] = await tx.select().from(posts).where(eq(posts.id, edit.postId)).for("update");
    if (!post) return edit.status;
    const targets = await editableTargets(tx, post);
    const results = edit.results as PostEditResult[];
    if (targets.some((t) => !results.some((r) => r.targetId === t.id))) return edit.status;
    const applied = results.filter((r) => r.status === "applied").length;
    const failed = results.length - applied;
    const status: PostEditStatus =
      applied === 0 ? "failed" : failed === 0 ? "applied" : "partly_applied";
    const now = new Date();
    if (applied > 0) {
      await tx
        .update(posts)
        .set({
          summary: edit.summary,
          cta: edit.cta,
          event: edit.event,
          offer: edit.offer,
          media: edit.media,
          updatedAt: now,
        })
        .where(eq(posts.id, post.id));
    }
    const [row] = await tx
      .update(postEdits)
      .set({ status, appliedAt: applied > 0 ? now : null, updatedAt: now })
      .where(and(eq(postEdits.id, edit.id), eq(postEdits.status, "applying")))
      .returning();
    await workerAudit(
      tx,
      edit.orgId,
    )({
      action: `post.edit_${status}`,
      entityType: "post",
      entityId: post.id,
      before: { editStatus: "applying" },
      after: { editStatus: status, applied, failed, ofLocations: targets.length, ...editAuditFields(post, row!) },
    });
    return status;
  });
}
