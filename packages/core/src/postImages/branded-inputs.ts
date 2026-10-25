import { and, eq } from "drizzle-orm";
import { postImages, storedFiles, type Tx } from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import { requireWorkspace } from "./store";

/**
 * The bytes one branded image is made from: a photo of this client's library and, if asked, this
 * client's own logo. The agency logo is never used on a client's post.
 */
export async function loadBrandedInputs(
  tx: Tx,
  actor: Actor,
  input: { workspaceId: string; photoImageId: string; useLogo: boolean },
): Promise<{ photo: Uint8Array; logo: Uint8Array | null }> {
  await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
  const [photo] = await tx
    .select({ bytes: postImages.bytes })
    .from(postImages)
    .where(
      and(
        eq(postImages.id, input.photoImageId),
        eq(postImages.orgId, actor.orgId),
        eq(postImages.workspaceId, input.workspaceId),
      ),
    );
  if (!photo) throw new AccessError("NOT_FOUND", "Image not found");
  let logo: Uint8Array | null = null;
  if (input.useLogo) {
    const [row] = await tx
      .select({ bytes: storedFiles.bytes })
      .from(storedFiles)
      .where(
        and(
          eq(storedFiles.orgId, actor.orgId),
          eq(storedFiles.workspaceId, input.workspaceId),
          eq(storedFiles.kind, "logo"),
        ),
      );
    logo = row?.bytes ?? null;
  }
  return { photo: photo.bytes, logo };
}
