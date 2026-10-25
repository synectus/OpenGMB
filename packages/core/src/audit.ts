import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { auditCheckpoints, auditLog, type auditSurface, type Db, type Tx } from "@opengmb/db";

export type AuditEntry = {
  orgId: string;
  actorUserId: string | null;
  actorType: "user" | "api_token" | "system";
  /** `cli` is for writes that bypass the action registry (e.g. the token script). */
  surface: (typeof auditSurface.enumValues)[number];
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

type Hashable = Omit<AuditEntry, "actorType"> & { actorType: string; createdAt: Date };

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

/** JSON with recursively sorted keys; normalised through JSON so it matches a jsonb round trip. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(v ?? null))));
}

function computeHash(prevHash: string | null, e: Hashable): string {
  const body = canonicalJson({
    org_id: e.orgId,
    actor_user_id: e.actorUserId,
    actor_type: e.actorType,
    surface: e.surface,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    created_at: e.createdAt.toISOString(),
  });
  return createHash("sha256")
    .update((prevHash ?? "") + body)
    .digest("hex");
}

export type AuditCheckpoint = typeof auditCheckpoints.$inferSelect;

function checkpointKey(): Buffer {
  const raw = process.env.AUDIT_CHECKPOINT_KEY;
  if (!raw) throw new Error("AUDIT_CHECKPOINT_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 32) throw new Error("AUDIT_CHECKPOINT_KEY must be base64 for at least 32 bytes");
  return buf;
}

/** HMAC-SHA256 (hex) over the canonical JSON of the checkpoint's fields. */
export function signCheckpoint(c: Omit<AuditCheckpoint, "signature">): string {
  const body = canonicalJson({
    org_id: c.orgId,
    last_id: c.lastId,
    last_hash: c.lastHash,
    row_count: c.rowCount,
    updated_at: c.updatedAt.toISOString(),
  });
  return createHmac("sha256", checkpointKey()).update(body).digest("hex");
}

function checkpointSignatureValid(c: AuditCheckpoint): boolean {
  const expected = Buffer.from(signCheckpoint(c), "hex");
  const actual = Buffer.from(c.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function saveCheckpoint(
  tx: Tx,
  c: { orgId: string; lastId: number; lastHash: string; rowCount: number; updatedAt: Date },
) {
  const row = { ...c, signature: signCheckpoint(c) };
  await tx
    .insert(auditCheckpoints)
    .values(row)
    .onConflictDoUpdate({ target: auditCheckpoints.orgId, set: row });
}

/**
 * Append an audit row inside the caller's transaction. The per-org advisory lock
 * serialises writers so the hash chain stays linear. Needs READ COMMITTED (the default):
 * a snapshot taken before the lock was granted would miss the previous writer's row.
 *
 * The signed checkpoint is advanced in the same transaction, so a committed audit row is
 * always covered by it. It is only advanced when the existing checkpoint is valid and matches
 * the head we just read; otherwise it is left as it is, so tampering stays visible to
 * verifyAuditChain instead of being re-signed. An org with rows but no checkpoint (created
 * before checkpoints existed) stays checkpoint-less until `backfillAuditCheckpoint` runs.
 */
export async function writeAudit(tx: Tx, entry: AuditEntry) {
  checkpointKey(); // fail before touching anything if the key is unusable
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${entry.orgId}::text, 0))`);
  const [last] = await tx
    .select({ id: auditLog.id, hash: auditLog.hash })
    .from(auditLog)
    .where(eq(auditLog.orgId, entry.orgId))
    .orderBy(desc(auditLog.id))
    .limit(1);
  const [cp] = await tx
    .select()
    .from(auditCheckpoints)
    .where(eq(auditCheckpoints.orgId, entry.orgId));
  const prevHash = last?.hash ?? null;
  const createdAt = new Date(); // ms precision, matches timestamp(3)
  const hash = computeHash(prevHash, { ...entry, createdAt });
  const [row] = await tx
    .insert(auditLog)
    .values({
      ...entry,
      before: entry.before ?? null,
      after: entry.after ?? null,
      createdAt,
      prevHash,
      hash,
    })
    .returning();
  const advance = last
    ? cp !== undefined &&
      checkpointSignatureValid(cp) &&
      cp.lastId === last.id &&
      cp.lastHash === last.hash
    : cp === undefined;
  if (advance) {
    await saveCheckpoint(tx, {
      orgId: entry.orgId,
      lastId: row!.id,
      lastHash: hash,
      rowCount: (cp?.rowCount ?? 0) + 1,
      updatedAt: createdAt,
    });
  }
  return row!;
}

export type AuditBreakKind =
  | "hash_mismatch"
  | "prev_link"
  | "checkpoint_missing"
  | "checkpoint_signature"
  | "checkpoint_mismatch";
export type AuditBreak = { id?: number; kind: AuditBreakKind; detail: string };
export type CheckpointStatus = "ok" | "missing" | "invalid_signature" | "mismatch";
export type AuditVerification = {
  ok: boolean;
  /** Audit rows examined (all of them; scanning continues past a break). */
  checked: number;
  breaks: AuditBreak[];
  checkpoint: CheckpointStatus;
  /** Id of the first row-level break, if any. */
  brokenAt?: number;
};

const MAX_REPORTED_BREAKS = 100;

/**
 * Walk the org's chain and compare its head with the signed checkpoint. Takes the org's
 * advisory lock in shared mode so no writer is mid-flight between the rows and the checkpoint
 * read (otherwise a concurrent commit would look like a mismatch); writers wait for it.
 * An org with no rows and no checkpoint is `ok` with checked 0: there is nothing to cover.
 */
export async function verifyAuditChain(db: Db | Tx, orgId: string): Promise<AuditVerification> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${orgId}::text, 0))`);
    const rows = await tx
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId))
      .orderBy(asc(auditLog.id));
    const [cp] = await tx.select().from(auditCheckpoints).where(eq(auditCheckpoints.orgId, orgId));

    const breaks: AuditBreak[] = [];
    const add = (b: AuditBreak) => {
      if (breaks.length < MAX_REPORTED_BREAKS) breaks.push(b);
    };
    let prev: string | null = null;
    for (const r of rows) {
      if (r.prevHash !== prev)
        add({
          id: r.id,
          kind: "prev_link",
          detail: `prev_hash ${r.prevHash ?? "null"} does not match the preceding row's hash ${prev ?? "null"} (a row was removed, inserted or reordered)`,
        });
      if (r.hash !== computeHash(r.prevHash, r))
        add({ id: r.id, kind: "hash_mismatch", detail: "stored hash does not match row contents" });
      prev = r.hash;
    }

    let checkpoint: CheckpointStatus;
    const head = rows.at(-1);
    if (!cp) {
      if (rows.length === 0) {
        checkpoint = "ok";
      } else {
        checkpoint = "missing";
        add({
          kind: "checkpoint_missing",
          detail: `${rows.length} audit rows but no signed checkpoint; run pnpm audit:checkpoint-backfill`,
        });
      }
    } else if (!checkpointSignatureValid(cp)) {
      checkpoint = "invalid_signature";
      add({
        kind: "checkpoint_signature",
        detail: "checkpoint signature does not verify with AUDIT_CHECKPOINT_KEY",
      });
    } else if (
      cp.lastId !== (head?.id ?? null) ||
      cp.lastHash !== (head?.hash ?? null) ||
      cp.rowCount !== rows.length
    ) {
      checkpoint = "mismatch";
      add({
        kind: "checkpoint_mismatch",
        detail: `signed checkpoint says last_id ${cp.lastId}, row_count ${cp.rowCount}, last_hash ${cp.lastHash}; table has last_id ${head?.id ?? "none"}, row_count ${rows.length}, last_hash ${head?.hash ?? "none"} (rows were deleted or truncated)`,
      });
    } else {
      checkpoint = "ok";
    }

    const first = breaks.find((b) => b.id !== undefined);
    return {
      ok: breaks.length === 0,
      checked: rows.length,
      breaks,
      checkpoint,
      ...(first ? { brokenAt: first.id } : {}),
    };
  });
}

/** Current signed checkpoint for an org, or null. */
export async function getAuditCheckpoint(
  db: Db | Tx,
  orgId: string,
): Promise<AuditCheckpoint | null> {
  const [cp] = await db.select().from(auditCheckpoints).where(eq(auditCheckpoints.orgId, orgId));
  return cp ?? null;
}

export type BackfillResult =
  | { kind: "skipped_has_checkpoint" }
  | { kind: "skipped_no_rows" }
  | { kind: "refused_chain_broken"; breaks: AuditBreak[] }
  | { kind: "written"; rowCount: number };

/**
 * One-off: give an org that predates checkpoints its first signed checkpoint. Everything runs
 * in one transaction under the org's advisory lock: re-verify the chain, and only if it is
 * intact write a checkpoint for the current head, then record an `audit.checkpoint_backfill`
 * audit row. That audit write goes through writeAudit, which sees a valid checkpoint matching
 * the head and advances it, so the final checkpoint covers the backfill row itself.
 * This blesses the chain as it is now: it cannot detect rows deleted before it ran.
 */
export async function backfillAuditCheckpoint(db: Db, orgId: string): Promise<BackfillResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId}::text, 0))`);
    const v = await verifyAuditChain(tx, orgId);
    if (v.checkpoint !== "missing") {
      return v.checked === 0 && v.checkpoint === "ok"
        ? { kind: "skipped_no_rows" }
        : { kind: "skipped_has_checkpoint" };
    }
    const chainBreaks = v.breaks.filter((b) => b.kind !== "checkpoint_missing");
    if (chainBreaks.length > 0) return { kind: "refused_chain_broken", breaks: chainBreaks };
    const [head] = await tx
      .select({ id: auditLog.id, hash: auditLog.hash, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId))
      .orderBy(desc(auditLog.id))
      .limit(1);
    await saveCheckpoint(tx, {
      orgId,
      lastId: head!.id,
      lastHash: head!.hash,
      rowCount: v.checked,
      updatedAt: new Date(),
    });
    await writeAudit(tx, {
      orgId,
      actorUserId: null,
      actorType: "system",
      surface: "cli",
      action: "audit.checkpoint_backfill",
      entityType: "audit_checkpoint",
      entityId: orgId,
      before: null,
      after: { last_id: head!.id, row_count: v.checked },
    });
    return { kind: "written", rowCount: v.checked + 1 };
  });
}
