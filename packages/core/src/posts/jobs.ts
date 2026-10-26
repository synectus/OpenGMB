import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { locations, postTargets, posts, type Db, type Tx } from "@opengmb/db";
import { GoogleApiError } from "../google/errors";
import { assertPassed, guardrailSubject, runGuardrails, type GuardrailResult } from "../guardrails";
import { deferBlockedJob, enqueueJob } from "../jobs";
import { clientFor, googleFailure } from "../reviews/reply-jobs";
import { workerAudit, type AuditFn } from "../reviews/reply-state";
import { contentFromRow, postAuditFields, type PostRow } from "./content";
import { buildPostGuardrailContext } from "./context";
import { publishPost, removeGooglePost, type PostWriter } from "./publish";
import { nextOccurrence, type Recurrence } from "./recurrence";
import { transitionPost } from "./state";
import { isOrgBlocked, orgIsActive } from "../account-state";

export const POST_SEND_QUEUE = "posts.send";
export const POST_DELETE_QUEUE = "posts.deleteGoogle";
export const POST_SWEEP_QUEUE = "posts.sweep";
/** Every minute. */
export const POST_SWEEP_CRON = "* * * * *";
/** Google errors are classified inside the job; pg-boss retries only unexpected errors. */
export const POST_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

export type PostSendJob = { postId: string; occurrence: number };
export type PostDeleteJob = { postId: string; locationIds: string[] | null; requestedBy: string };

/**
 * scheduled -> publishing and the send job, in the caller's transaction (the job exists iff the
 * claim commits). Used by the minute sweep and by `posts.schedule` for a post that is due now.
 */
export async function startPublishing(
  tx: Tx,
  p: { post: PostRow; audit: AuditFn; trigger: "sweep" | "schedule_now" },
): Promise<PostRow> {
  const row = await transitionPost(tx, {
    post: p.post,
    to: "publishing",
    action: "publish_started",
    audit: p.audit,
    extra: { trigger: p.trigger },
  });
  await enqueueJob(tx, POST_SEND_QUEUE, { postId: row.id, occurrence: row.occurrence });
  return row;
}

/**
 * The scheduling mechanism: a minute-level sweep (the database is the source of truth, so cancel
 * and reschedule need no job bookkeeping, and nothing depends on pg-boss retaining a far-future job).
 * Claims every `scheduled` post whose `scheduled_for` is at or before `now`, oldest first,
 * `FOR UPDATE SKIP LOCKED`, one short transaction per post. `orgIds` restricts the sweep to those
 * orgs (tests only: production sweeps every org, and a test sweep must not claim other tests' posts).
 */
export async function sweepDuePosts(
  db: Db,
  deps: { now?: Date; limit?: number; orgIds?: string[] } = {},
): Promise<{ claimed: number }> {
  const now = deps.now ?? new Date();
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.status, "scheduled"),
        lte(posts.scheduledFor, now),
        deps.orgIds ? inArray(posts.orgId, deps.orgIds) : undefined,
        orgIsActive(posts.orgId),
      ),
    )
    .orderBy(asc(posts.scheduledFor), asc(posts.id))
    .limit(deps.limit ?? 100);
  let claimed = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [post] = await tx
        .select()
        .from(posts)
        .where(and(eq(posts.id, id), eq(posts.status, "scheduled"), lte(posts.scheduledFor, now)))
        .for("update", { skipLocked: true });
      if (!post) return;
      await startPublishing(tx, { post, audit: workerAudit(tx, post.orgId), trigger: "sweep" });
      claimed++;
    });
  }
  return { claimed };
}

/** Why a send ended in failure/skip, stored on the target: a short code, never Google's body or text. */
const REASONS = {
  inactive: "location_inactive",
  unlinked: "location_not_linked_to_google",
  noConnection: "connection_removed",
  warnings: "warnings_require_acknowledgement",
  unexpected: "unexpected_error",
} as const;

async function settleTarget(
  db: Db,
  targetId: string,
  outcome:
    | { status: "published"; googlePostName: string | null }
    | { status: "failed" | "skipped"; error: string; guardrail?: GuardrailResult },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, targetId))
      .for("update");
    if (!t || t.status !== "pending") return;
    const [post] = await tx.select().from(posts).where(eq(posts.id, t.postId));
    if (!post) return;
    const now = new Date();
    await tx
      .update(postTargets)
      .set(
        outcome.status === "published"
          ? {
              status: "published",
              googlePostName: outcome.googlePostName,
              publishedAt: now,
              error: null,
              updatedAt: now,
            }
          : { status: outcome.status, error: outcome.error, updatedAt: now },
      )
      .where(eq(postTargets.id, t.id));
    await workerAudit(
      tx,
      t.orgId,
    )({
      action: `post.target_${outcome.status}`,
      entityType: "post_target",
      entityId: t.id,
      before: { status: "pending" },
      after: {
        status: outcome.status,
        locationId: t.locationId,
        ...postAuditFields(post, "guardrail" in outcome ? outcome.guardrail : undefined),
        ...("error" in outcome ? { error: outcome.error } : {}),
      },
    });
  });
}

/**
 * AP3b: a `publishing` post whose org is blocked goes back to `scheduled`, keeping its occurrence and its pending targets.
 * scheduled_for is left as it was (already due), so the sweep claims it as soon as the org is active again.
 */
async function pauseBlockedPost(tx: Tx, post: PostRow): Promise<void> {
  await transitionPost(tx, {
    post,
    to: "scheduled",
    action: "publish_paused",
    set: post.scheduledFor ? {} : { scheduledFor: new Date() },
    audit: workerAudit(tx, post.orgId),
    extra: { reason: "account_blocked" },
  });
}

type Outcome = Parameters<typeof settleTarget>[2];
type Prepared =
  | { kind: "settle"; outcome: Exclude<Outcome, { status: "published" }> }
  | { kind: "gone" }
  | {
      kind: "send";
      parent: string;
      language: string;
      connectionId: string | null;
      content: ReturnType<typeof contentFromRow>;
      passed: ReturnType<typeof assertPassed>;
    };

/**
 * Worker side of `posts.send` for one occurrence of a `publishing` post. For each pending target,
 * in order:
 *   1. one short transaction: rebuild THIS location's guardrail context and run the guardrails
 *      again (rules, settings and the location may have changed since submit). A block fails the
 *      target (rule ids only), unacknowledged warnings fail it, an inactive or unlinked location
 *      skips it;
 *   2. no transaction: `publishPost` (needs the branded GuardrailPassed for exactly this content)
 *      through the throttled client, idempotency key `post:<postId>:<locationId>:<occurrence>`;
 *   3. one short transaction: the target becomes published/failed and an audit row is written.
 * Google 4xx/429 fail only that target; other errors leave it pending and the job throws so pg-boss
 * retries (the idempotency key prevents a second create), and on the final attempt the target fails.
 * Then the post is finalised: `published` if at least one target published (per-location results
 * carry the failures), `failed` if none did. A recurring post that published goes back to
 * `scheduled` for its next occurrence (computed from the anchor, past ones skipped) with new
 * pending targets. Safe to re-run: only pending targets are processed.
 */
export async function processPostSend(
  db: Db,
  job: PostSendJob,
  deps: { client?: PostWriter; isFinalAttempt?: boolean; now?: Date } = {},
): Promise<PostRow["status"] | null> {
  const loaded = await db.transaction(async (tx) => {
    const [post] = await tx.select().from(posts).where(eq(posts.id, job.postId));
    if (!post || post.status !== "publishing" || post.occurrence !== job.occurrence) return null;
    // AP3b: suspended or deleted. Back to `scheduled` (a legal move) so the minute sweep claims it again after unsuspend.
    if (await isOrgBlocked(tx, post.orgId)) {
      await pauseBlockedPost(tx, post);
      return null;
    }
    const targets = await tx
      .select()
      .from(postTargets)
      .where(
        and(
          eq(postTargets.postId, post.id),
          eq(postTargets.occurrence, job.occurrence),
          eq(postTargets.status, "pending"),
        ),
      )
      .orderBy(asc(postTargets.createdAt), asc(postTargets.id));
    return { post, targets };
  });
  if (!loaded) return null;

  let unexpected: unknown = null;
  const clients = new Map<string, PostWriter | null>();
  for (const t of loaded.targets) {
    // 1. guardrails again, for this location
    const prepared = await db.transaction(async (tx): Promise<Prepared> => {
      const [cur] = await tx.select().from(posts).where(eq(posts.id, job.postId));
      if (!cur || cur.status !== "publishing") return { kind: "gone" };
      if (await isOrgBlocked(tx, cur.orgId)) {
        await pauseBlockedPost(tx, cur);
        return { kind: "gone" };
      }
      const [loc] = await tx.select().from(locations).where(eq(locations.id, t.locationId));
      if (!loc || loc.status !== "active") {
        return { kind: "settle", outcome: { status: "skipped", error: REASONS.inactive } };
      }
      if (!loc.googleAccountName || !loc.googleLocationId) {
        return { kind: "settle", outcome: { status: "skipped", error: REASONS.unlinked } };
      }
      const content = contentFromRow(cur);
      const ctx = await buildPostGuardrailContext(tx, {
        workspaceId: cur.workspaceId,
        locationId: loc.id,
        content,
      });
      if (!ctx) return { kind: "settle", outcome: { status: "skipped", error: REASONS.inactive } };
      const result = runGuardrails(ctx);
      if (!result.ok) {
        const ids = [
          ...new Set(result.violations.filter((v) => v.severity === "block").map((v) => v.ruleId)),
        ];
        return {
          kind: "settle",
          outcome: {
            status: "failed",
            error: `guardrail_blocked:${ids.join(",")}`,
            guardrail: result,
          },
        };
      }
      if (result.violations.length > 0 && !cur.warningsAcknowledged) {
        return {
          kind: "settle",
          outcome: { status: "failed", error: REASONS.warnings, guardrail: result },
        };
      }
      return {
        kind: "send",
        parent: `${loc.googleAccountName}/${loc.googleLocationId}`,
        language: cur.language,
        connectionId: loc.connectionId,
        content,
        passed: assertPassed(result, guardrailSubject(ctx)),
      };
    });
    if (prepared.kind === "gone") break;
    if (prepared.kind === "settle") {
      await settleTarget(db, t.id, prepared.outcome);
      continue;
    }

    // 2. Google, no transaction open
    const key = prepared.connectionId ?? "";
    if (!deps.client && !clients.has(key)) {
      clients.set(key, await clientFor(db, t.orgId, prepared.connectionId));
    }
    const client = deps.client ?? clients.get(key) ?? null;
    if (!client) {
      await settleTarget(db, t.id, { status: "failed", error: REASONS.noConnection });
      continue;
    }
    try {
      const sent = await publishPost(
        client,
        {
          orgId: t.orgId,
          postId: t.postId,
          locationId: t.locationId,
          occurrence: t.occurrence,
          parent: prepared.parent,
          languageCode: prepared.language,
        },
        prepared.content,
        prepared.passed,
      );
      // 3. record
      await settleTarget(db, t.id, { status: "published", googlePostName: sent.name ?? null });
    } catch (e) {
      const reason = googleFailure(e);
      if (reason) await settleTarget(db, t.id, { status: "failed", error: reason });
      else if (deps.isFinalAttempt) {
        await settleTarget(db, t.id, { status: "failed", error: REASONS.unexpected });
      } else unexpected ??= e;
    }
  }
  if (unexpected) throw unexpected;
  return finalizePostSend(db, job, deps.now ?? new Date());
}

/** Post-level outcome of one occurrence; see `processPostSend`. */
async function finalizePostSend(
  db: Db,
  job: PostSendJob,
  now: Date,
): Promise<PostRow["status"] | null> {
  return db.transaction(async (tx) => {
    const [post] = await tx.select().from(posts).where(eq(posts.id, job.postId)).for("update");
    if (!post || post.status !== "publishing" || post.occurrence !== job.occurrence) {
      return post?.status ?? null;
    }
    const targets = await tx
      .select()
      .from(postTargets)
      .where(and(eq(postTargets.postId, post.id), eq(postTargets.occurrence, job.occurrence)));
    if (targets.some((t) => t.status === "pending")) return post.status;
    const counts = {
      published: targets.filter((t) => t.status === "published").length,
      failed: targets.filter((t) => t.status === "failed").length,
      skipped: targets.filter((t) => t.status === "skipped").length,
    };
    const audit = workerAudit(tx, post.orgId);
    if (counts.published === 0) {
      return (
        await transitionPost(tx, {
          post,
          to: "failed",
          action: "failed",
          audit,
          extra: { ...counts, ofLocations: targets.length },
        })
      ).status;
    }
    const rec = post.recurrence as Recurrence | null;
    const next = rec ? nextOccurrence(rec, post.occurrence, now) : null;
    if (!rec || !next) {
      return (
        await transitionPost(tx, {
          post,
          to: "published",
          action: "published",
          audit,
          extra: { ...counts, ofLocations: targets.length },
        })
      ).status;
    }
    const row = await transitionPost(tx, {
      post,
      to: "scheduled",
      action: "occurrence_published",
      set: { scheduledFor: next.at, occurrence: next.index },
      audit,
      extra: {
        ...counts,
        ofLocations: targets.length,
        nextOccurrence: next.index,
        nextAt: next.at.toISOString(),
        skippedOccurrences: next.skipped,
      },
    });
    await tx.insert(postTargets).values(
      targets.map((t) => ({
        postId: post.id,
        orgId: post.orgId,
        locationId: t.locationId,
        occurrence: next.index,
      })),
    );
    return row.status;
  });
}

/**
 * Worker side of `posts.deleteGoogle`: removes the Google posts of the post's published targets
 * (all of them, or those at `locationIds`). Google 404 counts as already deleted; a Google failure
 * keeps the target `published` with an error code and is audited (`post.target_delete_failed`),
 * no retry; unexpected errors are thrown for pg-boss. Returns how many targets are now deleted.
 */
export async function processPostDelete(
  db: Db,
  job: PostDeleteJob,
  deps: { client?: PostWriter; isFinalAttempt?: boolean } = {},
): Promise<{ deleted: number; failed: number }> {
  // AP3b: suspended or deleted at job start. The targets stay `published`; the job is re-queued for later.
  const paused = await db.transaction(async (tx) => {
    const [p] = await tx.select({ orgId: posts.orgId }).from(posts).where(eq(posts.id, job.postId));
    if (!p || !(await isOrgBlocked(tx, p.orgId))) return false;
    await deferBlockedJob(tx, POST_DELETE_QUEUE, job, p.orgId);
    return true;
  });
  if (paused) return { deleted: 0, failed: 0 };
  const targets = await db
    .select({ t: postTargets, connectionId: locations.connectionId })
    .from(postTargets)
    .innerJoin(locations, eq(locations.id, postTargets.locationId))
    .where(
      and(
        eq(postTargets.postId, job.postId),
        eq(postTargets.status, "published"),
        job.locationIds ? inArray(postTargets.locationId, job.locationIds) : undefined,
      ),
    )
    .orderBy(asc(postTargets.occurrence), asc(postTargets.id));
  let deleted = 0;
  let failed = 0;
  let unexpected: unknown = null;
  const clients = new Map<string, PostWriter | null>();
  for (const { t, connectionId } of targets) {
    if (!t.googlePostName) continue;
    const key = connectionId ?? "";
    if (!deps.client && !clients.has(key))
      clients.set(key, await clientFor(db, t.orgId, connectionId));
    const client = deps.client ?? clients.get(key) ?? null;
    let error: string | null = client ? null : REASONS.noConnection;
    if (client) {
      try {
        await removeGooglePost(client, {
          orgId: t.orgId,
          targetId: t.id,
          postName: t.googlePostName,
        });
      } catch (e) {
        if (!(e instanceof GoogleApiError && e.status === 404)) {
          error = googleFailure(e);
          if (!error) {
            if (deps.isFinalAttempt) error = REASONS.unexpected;
            else {
              unexpected ??= e;
              continue;
            }
          }
        }
      }
    }
    await db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(postTargets)
        .where(and(eq(postTargets.id, t.id), eq(postTargets.status, "published")))
        .for("update");
      const [post] = await tx.select().from(posts).where(eq(posts.id, t.postId));
      if (!cur || !post) return;
      await tx
        .update(postTargets)
        .set(
          error
            ? { error: `delete_failed:${error}`, updatedAt: new Date() }
            : { status: "deleted", error: null, updatedAt: new Date() },
        )
        .where(eq(postTargets.id, t.id));
      await workerAudit(
        tx,
        t.orgId,
      )({
        action: error ? "post.target_delete_failed" : "post.target_deleted",
        entityType: "post_target",
        entityId: t.id,
        before: { status: "published" },
        after: {
          status: error ? "published" : "deleted",
          locationId: t.locationId,
          requestedBy: job.requestedBy,
          ...postAuditFields(post),
          ...(error ? { error } : {}),
        },
      });
    });
    if (error) failed++;
    else deleted++;
  }
  if (unexpected) throw unexpected;
  return { deleted, failed };
}
