import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { postImages, postTemplates, posts, users, workspaces, type Db, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { MEDIA_LIMITS } from "../config/media-limits";
import { CoreError } from "../errors";
import { inspectImage } from "../media/image";
import { cleanFilename } from "../media/upload";
import { roleHasPermission } from "../permissions";
import type { ActionAuditEntry } from "../registry";
import { writeAudit } from "../audit";
import { assertWithinQuota } from "../storage/store";

/** Posts in these states can still be sent without another human step, or are waiting for one. */
export const BLOCKING_POST_STATUSES = ["pending_approval", "approved", "scheduled", "publishing"] as const;
export const LIBRARY_LIST_CAP = 500;
const TOKEN_RE = /^[0-9a-f]{48}$/;
const URL_TOKEN_RE = /\/m\/([0-9a-f]{48})(?![0-9a-f])/g;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function publicPostImageUrl(token: string, base = process.env.BETTER_AUTH_URL ?? ""): string {
  return `${base.replace(/\/+$/, "")}/m/${token}`;
}

/** Library tokens referenced by a post's `media` jsonb. */
export function tokensIn(media: unknown): string[] {
  if (!Array.isArray(media)) return [];
  const out: string[] = [];
  for (const m of media) {
    const u = (m as { sourceUrl?: unknown } | null)?.sourceUrl;
    if (typeof u !== "string") continue;
    for (const hit of u.matchAll(URL_TOKEN_RE)) out.push(hit[1]!);
  }
  return out;
}

/** First non-empty line of the post text, clipped. */
export function titleOf(summary: string): string {
  const line = summary.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 60) || "(no text)";
}

export async function requireWorkspace(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  permission: Parameters<typeof authorize>[1],
): Promise<void> {
  authorize(actor, permission, { workspaceId });
  const [ws] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
}

export const canManageLibrary = (actor: Actor) => roleHasPermission(actor.role, "review:draft");

/** Every column except the bytes. */
export const imageColumns = {
  id: postImages.id,
  workspaceId: postImages.workspaceId,
  name: postImages.name,
  token: postImages.token,
  contentType: postImages.contentType,
  byteSize: postImages.byteSize,
  width: postImages.width,
  height: postImages.height,
  source: postImages.source,
  creditName: postImages.creditName,
  creditUrl: postImages.creditUrl,
  aiGenerated: postImages.aiGenerated,
  createdAt: postImages.createdAt,
  createdBy: postImages.createdBy,
};

export type UsedIn = { postId: string; status: string; title: string };

/** token -> posts of the workspace that use it (any status). One query. */
export async function usageByToken(tx: Tx, workspaceId: string): Promise<Map<string, UsedIn[]>> {
  const rows = await tx
    .select({ id: posts.id, status: posts.status, summary: posts.summary, media: posts.media })
    .from(posts)
    .where(and(eq(posts.workspaceId, workspaceId), sql`${posts.media}::text like '%/m/%'`))
    .orderBy(desc(posts.createdAt))
    .limit(5000);
  const map = new Map<string, UsedIn[]>();
  for (const r of rows) {
    for (const token of new Set(tokensIn(r.media))) {
      const list = map.get(token) ?? [];
      list.push({ postId: r.id, status: r.status, title: titleOf(r.summary) });
      map.set(token, list);
    }
  }
  return map;
}

export async function templateCounts(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ imageId: postTemplates.imageId, n: sql<number>`count(*)::int` })
    .from(postTemplates)
    .where(eq(postTemplates.workspaceId, workspaceId))
    .groupBy(postTemplates.imageId);
  return new Map(rows.flatMap((r) => (r.imageId ? [[r.imageId, r.n] as const] : [])));
}

export function deleteBlockedBy(used: UsedIn[]): "scheduled" | "waiting" | null {
  const blocking = used.filter((u) => (BLOCKING_POST_STATUSES as readonly string[]).includes(u.status));
  if (blocking.length === 0) return null;
  return blocking.every((u) => u.status === "pending_approval") ? "waiting" : "scheduled";
}

export type CreatePostImageInput = {
  workspaceId: string;
  filename: string;
  bytes: Uint8Array;
  /** A8: stock photos carry the photographer's credit, AI images are flagged. Uploads leave these out. */
  origin?: { source: "stock"; creditName: string; creditUrl: string } | { source: "ai" };
};

export async function createPostImageTx(
  tx: Tx,
  actor: Actor,
  audit: (entry: ActionAuditEntry) => Promise<void>,
  input: CreatePostImageInput,
) {
  await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
  const max = MEDIA_LIMITS.photo.maxBytes;
  if (input.bytes.length > max) {
    throw new CoreError("INVALID_INPUT", `Photo is larger than ${max / 1024 / 1024} MB`);
  }
  const info = inspectImage(input.bytes); // JPEG or PNG only, from the bytes
  if (info.width < 1 || info.height < 1) throw new CoreError("INVALID_INPUT", "Photo has no pixels");
  const digest = sha256(input.bytes);
  await assertWithinQuota(tx, actor.orgId, input.bytes.length);
  const [row] = await tx
    .insert(postImages)
    .values({
      orgId: actor.orgId,
      workspaceId: input.workspaceId,
      createdBy: actor.userId,
      name: cleanFilename(input.filename),
      token: randomBytes(24).toString("hex"),
      contentType: info.contentType,
      byteSize: input.bytes.length,
      width: info.width,
      height: info.height,
      sha256: digest,
      bytes: Buffer.from(input.bytes),
      source: input.origin?.source ?? "upload",
      creditName: input.origin?.source === "stock" ? input.origin.creditName : null,
      creditUrl: input.origin?.source === "stock" ? input.origin.creditUrl : null,
      aiGenerated: input.origin?.source === "ai",
    })
    .returning();
  await audit({
    action: "post_image.uploaded",
    entityType: "post_image",
    entityId: row!.id,
    after: {
      workspaceId: input.workspaceId,
      contentType: info.contentType,
      byteSize: input.bytes.length,
      width: info.width,
      height: info.height,
      sha256: digest,
    },
  });
  return row!;
}

/** `createPostImageTx` in its own transaction, for the upload route. */
export function createPostImage(db: Db, actor: Actor, input: CreatePostImageInput) {
  return db.transaction((tx) =>
    createPostImageTx(
      tx,
      actor,
      async (entry) => {
        await writeAudit(tx, {
          ...entry,
          orgId: actor.orgId,
          actorUserId: actor.userId,
          actorType: actor.actorType,
          surface: actor.surface,
        });
      },
      input,
    ),
  );
}

/** Bytes for the public route. Anything that is not a 48-hex token is null without a query. */
export async function getPublicPostImage(db: Db, token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ contentType: postImages.contentType, bytes: postImages.bytes })
    .from(postImages)
    .where(eq(postImages.token, token));
  return row ?? null;
}

export async function creatorNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
