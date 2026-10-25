import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  mediaUploads,
  postImages,
  reportRuns,
  storedFiles,
  workspaces,
  type Db,
  type Tx,
} from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import {
  STORED_FILE_MAX_BYTES,
  STORED_FILE_TYPES,
  storageQuotaBytes,
} from "../config/storage-limits";
import { CoreError } from "../errors";
import { inspectImage } from "../media/image";

export type StoredFileKind = (typeof storedFiles.$inferSelect)["kind"];

/** Refused because the organization would pass its storage allowance. Carries the numbers. */
export class StorageQuotaError extends CoreError {
  constructor(
    public readonly usedBytes: number,
    public readonly limitBytes: number,
    public readonly addBytes: number,
  ) {
    super(
      "CONFLICT",
      `Storage is full: ${formatMb(usedBytes)} of ${formatMb(limitBytes)} used, and this file adds ${formatMb(addBytes)}. Delete some images or files to free space.`,
    );
    this.name = "StorageQuotaError";
  }
}

export const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** PNG, JPEG or WebP from the first bytes. Anything else, SVG included, is INVALID_INPUT. */
export function sniffStoredFileType(bytes: Uint8Array): (typeof STORED_FILE_TYPES)[number] {
  const isWebp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  if (isWebp) return "image/webp";
  try {
    return inspectImage(bytes).contentType;
  } catch {
    throw new CoreError("INVALID_INPUT", "Only PNG, JPG and WebP images are accepted (SVG is not)");
  }
}

export type StorageUsage = {
  usedBytes: number;
  limitBytes: number;
  /** Where the bytes are. `storedFiles` is this module; the rest are older binary stores. */
  breakdown: { storedFiles: number; postImages: number; mediaUploads: number; reportPdfs: number };
};

/**
 * What an organization uses: stored_files, the post image library, staged photo uploads whose bytes
 * are not purged yet, and report PDFs. Sizes come from the byte_size columns written with the bytes.
 */
export async function orgUsage(db: Db | Tx, orgId: string): Promise<StorageUsage> {
  const rows = await db.execute<{ f: string; p: string; m: string; r: string }>(sql`
    select
      (select coalesce(sum(byte_size), 0) from ${storedFiles} where org_id = ${orgId}) as f,
      (select coalesce(sum(byte_size), 0) from ${postImages} where org_id = ${orgId}) as p,
      (select coalesce(sum(byte_size), 0) from ${mediaUploads} where org_id = ${orgId} and bytes is not null) as m,
      (select coalesce(sum(pdf_bytes), 0) from ${reportRuns} where org_id = ${orgId} and pdf is not null) as r`);
  const row = (rows as unknown as { f: string; p: string; m: string; r: string }[])[0]!;
  const breakdown = {
    storedFiles: Number(row.f),
    postImages: Number(row.p),
    mediaUploads: Number(row.m),
    reportPdfs: Number(row.r),
  };
  return {
    usedBytes: breakdown.storedFiles + breakdown.postImages + breakdown.mediaUploads + breakdown.reportPdfs,
    limitBytes: storageQuotaBytes(),
    breakdown,
  };
}

/**
 * Refuse when `addBytes` (less `freedBytes` that the same transaction removes) would pass the
 * allowance. Takes a per-organization lock for the rest of the transaction so two uploads cannot
 * both pass the check. Exactly the limit is allowed.
 */
export async function assertWithinQuota(tx: Tx, orgId: string, addBytes: number, freedBytes = 0): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"storage:" + orgId}))`);
  const { usedBytes, limitBytes } = await orgUsage(tx, orgId);
  if (usedBytes - freedBytes + addBytes > limitBytes) {
    throw new StorageQuotaError(usedBytes - freedBytes, limitBytes, addBytes);
  }
}

/** NOT_FOUND unless the workspace is a client of this organization. */
export async function assertWorkspaceInOrg(tx: Tx, orgId: string, workspaceId: string): Promise<void> {
  const [ws] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)));
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
}

export type PutFileInput = {
  workspaceId: string | null;
  kind: StoredFileKind;
  bytes: Uint8Array;
};

const slot = (orgId: string, workspaceId: string | null) =>
  workspaceId === null
    ? and(eq(storedFiles.orgId, orgId), isNull(storedFiles.workspaceId))
    : and(eq(storedFiles.orgId, orgId), eq(storedFiles.workspaceId, workspaceId));

/**
 * Store a file for an organization (or one of its clients). Checks the type from the bytes, the
 * per-kind size cap and the storage allowance. The same bytes already in the slot are returned as
 * they are (dedupe by sha256: no second row, no extra usage). A logo replaces the slot's old logo
 * in the same transaction, and the old file is deleted. Returns the row without its bytes.
 * Authorization is the caller's job.
 */
export async function putStoredFile(tx: Tx, actor: Pick<Actor, "orgId" | "userId">, input: PutFileInput) {
  const max = STORED_FILE_MAX_BYTES[input.kind];
  if (input.bytes.length === 0) throw new CoreError("INVALID_INPUT", "The file is empty");
  if (input.bytes.length > max) {
    throw new CoreError("INVALID_INPUT", `File is larger than ${max / 1024 / 1024} MB`);
  }
  const contentType = sniffStoredFileType(input.bytes);
  if (input.workspaceId !== null) await assertWorkspaceInOrg(tx, actor.orgId, input.workspaceId);
  const digest = sha256(input.bytes);
  const where = and(slot(actor.orgId, input.workspaceId), eq(storedFiles.kind, input.kind));
  // Lock first so the existing-row read and the quota check see one consistent state.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"storage:" + actor.orgId}))`);
  const existing = await tx
    .select({ id: storedFiles.id, sha256: storedFiles.sha256, byteSize: storedFiles.byteSize })
    .from(storedFiles)
    .where(where);
  const same = existing.find((e) => e.sha256 === digest);
  if (same) return { ...(await fileMeta(tx, same.id))!, deduped: true, replacedId: null as string | null };
  // A logo has one slot, so the old one goes; other kinds can hold several files.
  const replaced = input.kind === "logo" ? existing : [];
  const freed = replaced.reduce((n, r) => n + r.byteSize, 0);
  await assertWithinQuota(tx, actor.orgId, input.bytes.length, freed);
  for (const r of replaced) await tx.delete(storedFiles).where(eq(storedFiles.id, r.id));
  const [row] = await tx
    .insert(storedFiles)
    .values({
      orgId: actor.orgId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      contentType,
      byteSize: input.bytes.length,
      sha256: digest,
      bytes: Buffer.from(input.bytes),
      createdBy: actor.userId,
    })
    .returning();
  return { ...(await fileMeta(tx, row!.id))!, deduped: false, replacedId: replaced[0]?.id ?? null };
}

/** Every column except the bytes. */
async function fileMeta(tx: Tx | Db, id: string) {
  const [row] = await tx
    .select({
      id: storedFiles.id,
      orgId: storedFiles.orgId,
      workspaceId: storedFiles.workspaceId,
      kind: storedFiles.kind,
      contentType: storedFiles.contentType,
      byteSize: storedFiles.byteSize,
      sha256: storedFiles.sha256,
      createdBy: storedFiles.createdBy,
      createdAt: storedFiles.createdAt,
    })
    .from(storedFiles)
    .where(eq(storedFiles.id, id));
  return row ?? null;
}

/**
 * The file's bytes if this actor may see it: same organization, and a client-scoped actor (portal)
 * only files of its own clients plus the organization's own (the agency logo). Otherwise null, so
 * a wrong organization and a missing id look the same.
 */
export async function getStoredFileFor(db: Db | Tx, actor: Actor, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await db
    .select({
      orgId: storedFiles.orgId,
      workspaceId: storedFiles.workspaceId,
      contentType: storedFiles.contentType,
      bytes: storedFiles.bytes,
    })
    .from(storedFiles)
    .where(eq(storedFiles.id, id));
  if (!row || row.orgId !== actor.orgId) return null;
  if (row.workspaceId !== null && actor.workspaceIds !== "all" && !actor.workspaceIds.includes(row.workspaceId)) {
    return null;
  }
  return { contentType: row.contentType, bytes: row.bytes };
}

/** Delete the slot's logo; returns whether one existed. */
export async function deleteLogo(tx: Tx, orgId: string, workspaceId: string | null): Promise<boolean> {
  const gone = await tx
    .delete(storedFiles)
    .where(and(slot(orgId, workspaceId), eq(storedFiles.kind, "logo")))
    .returning({ id: storedFiles.id });
  return gone.length > 0;
}

/** File ids of the logos the actor may see: the organization's, and one per client in scope. */
export async function logoIdsFor(db: Db | Tx, actor: Actor) {
  const rows = await db
    .select({ id: storedFiles.id, workspaceId: storedFiles.workspaceId })
    .from(storedFiles)
    .where(and(eq(storedFiles.orgId, actor.orgId), eq(storedFiles.kind, "logo")));
  const scope = actor.workspaceIds;
  return {
    orgLogoFileId: rows.find((r) => r.workspaceId === null)?.id ?? null,
    workspaceLogos: rows
      .filter((r) => r.workspaceId !== null && (scope === "all" || scope.includes(r.workspaceId)))
      .map((r) => ({ workspaceId: r.workspaceId!, fileId: r.id })),
  };
}
