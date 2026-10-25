import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { postImages } from "@opengmb/db";
import { AccessError } from "../actor";
import { CoreError } from "../errors";
import { cleanFilename } from "../media/upload";
import {
  canManageLibrary,
  createPostImageTx,
  creatorNames,
  deleteBlockedBy,
  imageColumns,
  LIBRARY_LIST_CAP,
  publicPostImageUrl,
  requireWorkspace,
  templateCounts,
  usageByToken,
  type UsedIn,
} from "../postImages/store";
import { POST_IMAGE_LAYOUTS, POST_IMAGE_TEXT } from "../config/post-image-templates";
import { renderBrandedImage } from "../postImages/branded";
import { loadBrandedInputs } from "../postImages/branded-inputs";
import { normaliseText } from "../postImages/text-layout";
import { defineAction } from "../registry";

const imageOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  source: z.enum(["upload", "stock", "ai"]),
  /** Stock photos: "Image by {creditName} from Pixabay", linked to creditUrl. Null otherwise. */
  creditName: z.string().nullable(),
  creditUrl: z.string().nullable(),
  /** True for AI-made images; the app labels them so. */
  aiGenerated: z.boolean(),
  /** Public https URL that Google fetches; put it in a post's media sourceUrl. */
  url: z.string(),
  createdAt: z.string(),
  createdByName: z.string(),
  usedIn: z.array(z.object({ postId: z.string(), status: z.string(), title: z.string() })),
  templateCount: z.number().int(),
  canDelete: z.boolean(),
  /** "scheduled": a pending, approved, scheduled or publishing post; "waiting": only pending approval. */
  deleteBlockedBy: z.enum(["scheduled", "waiting"]).nullable(),
});

export const postImagesList = defineAction({
  name: "postImages.list",
  description:
    "List a workspace's post image library (JPG or PNG, up to 5 MB each, newest first, at most 500). Each image has a public `url`: pass it as a post's media sourceUrl (posts.createDraft / posts.updateDraft, one image per post) to attach it. `usedIn` lists the posts that use it with their status; canDelete is false while a pending, approved, scheduled or publishing post uses it. Images are uploaded in the web app; agents cannot upload or delete.",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ images: z.array(imageOut), can: z.object({ manage: z.boolean() }) }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:read");
    const rows = await tx
      .select(imageColumns)
      .from(postImages)
      .where(and(eq(postImages.orgId, actor.orgId), eq(postImages.workspaceId, input.workspaceId)))
      .orderBy(desc(postImages.createdAt), desc(postImages.id))
      .limit(LIBRARY_LIST_CAP);
    const [usage, counts, names] = await Promise.all([
      usageByToken(tx, input.workspaceId),
      templateCounts(tx, input.workspaceId),
      creatorNames(tx, [...new Set(rows.map((r) => r.createdBy))]),
    ]);
    return {
      can: { manage: canManageLibrary(actor) },
      images: rows.map((r) => {
        const used: UsedIn[] = usage.get(r.token) ?? [];
        const blockedBy = deleteBlockedBy(used);
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          name: r.name,
          contentType: r.contentType,
          byteSize: r.byteSize,
          width: r.width,
          height: r.height,
          source: r.source,
          creditName: r.creditName,
          creditUrl: r.creditUrl,
          aiGenerated: r.aiGenerated,
          url: publicPostImageUrl(r.token),
          createdAt: r.createdAt.toISOString(),
          createdByName: names.get(r.createdBy) ?? "",
          usedIn: used,
          templateCount: counts.get(r.id) ?? 0,
          canDelete: blockedBy === null,
          deleteBlockedBy: blockedBy,
        };
      }),
    };
  },
});

async function loadImage(
  tx: Parameters<typeof requireWorkspace>[0],
  actor: Parameters<typeof requireWorkspace>[1],
  id: string,
) {
  const [row] = await tx
    .select(imageColumns)
    .from(postImages)
    .where(and(eq(postImages.id, id), eq(postImages.orgId, actor.orgId)));
  if (!row) throw new AccessError("NOT_FOUND", "Image not found");
  await requireWorkspace(tx, actor, row.workspaceId, "review:draft");
  return row;
}

export const postImagesRename = defineAction({
  name: "postImages.rename",
  description: "Rename an image in the post image library (a display name only; the public URL does not change). Needs review:draft (owner, admin, manager).",
  input: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) }),
  output: z.object({ image: z.object({ id: z.string(), name: z.string() }) }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const row = await loadImage(tx, actor, input.id);
    const name = cleanFilename(input.name);
    await tx.update(postImages).set({ name }).where(eq(postImages.id, row.id));
    await audit({
      action: "post_image.renamed",
      entityType: "post_image",
      entityId: row.id,
      after: { workspaceId: row.workspaceId },
    });
    return { image: { id: row.id, name } };
  },
});

export const postImagesDelete = defineAction({
  name: "postImages.delete",
  description:
    "Delete an image from the post image library. Refused (CONFLICT) while a pending, approved, scheduled or publishing post uses it. Posts already on Google keep their copy; a draft that uses it will show a missing image. Not available to agents (FORBIDDEN over MCP). Needs review:draft.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.literal(true) }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    if (actor.surface === "mcp") {
      throw new CoreError("FORBIDDEN", "Deleting library images is not available to agents");
    }
    const row = await loadImage(tx, actor, input.id);
    const used = (await usageByToken(tx, row.workspaceId)).get(row.token) ?? [];
    if (deleteBlockedBy(used) !== null) {
      throw new CoreError("CONFLICT", "A post that has not been sent yet uses this image");
    }
    await tx.delete(postImages).where(eq(postImages.id, row.id));
    await audit({
      action: "post_image.deleted",
      entityType: "post_image",
      entityId: row.id,
      after: { workspaceId: row.workspaceId, usedByPosts: used.length },
    });
    return { deleted: true as const };
  },
});

export const brandedImageInput = z.object({
  workspaceId: z.uuid(),
  photoImageId: z.uuid(),
  layout: z.enum(POST_IMAGE_LAYOUTS),
  headline: z.string().transform(normaliseText).pipe(z.string().min(1).max(POST_IMAGE_TEXT.headlineMax)),
  subline: z.string().optional().default("").transform(normaliseText).pipe(z.string().max(POST_IMAGE_TEXT.sublineMax)),
  useLogo: z.boolean().default(true),
});

export const postImagesRenderBranded = defineAction({
  name: "postImages.renderBranded",
  description:
    "Make a branded post image: take a photo from the client's post image library (photoImageId from postImages.list), draw the client's uploaded logo (if it has one) and a headline plus optional second line over it in a fixed white layout ('band' along the bottom, or 'frame'), and save the result to the same library as a 1200x900 JPEG. Returns the new image; put its url in a post's media sourceUrl. The same inputs always give the same image. Latin-script (English) text only. Needs review:draft.",
  input: brandedImageInput,
  output: z.object({
    image: z.object({
      id: z.string(),
      url: z.string(),
      name: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      byteSize: z.number().int(),
      contentType: z.string(),
    }),
  }),
  permission: "review:draft",
  kind: "write",
  // approval omitted: two_phase, so an agent's call is a proposal a person applies.
  async handler({ tx, actor, audit }, input) {
    const { photo, logo } = await loadBrandedInputs(tx, actor, input);
    const out = await renderBrandedImage({
      layout: input.layout,
      headline: input.headline,
      subline: input.subline,
      photo,
      logo,
    });
    const row = await createPostImageTx(tx, actor, audit, {
      workspaceId: input.workspaceId,
      filename: `Branded ${input.layout} - ${input.headline.slice(0, 40)}`,
      bytes: out.bytes,
    });
    // The headline is post text and never goes in the audit log.
    await audit({
      action: "post_image.rendered",
      entityType: "post_image",
      entityId: row.id,
      after: {
        workspaceId: input.workspaceId,
        sourceImageId: input.photoImageId,
        layout: input.layout,
        usedLogo: logo !== null,
        sha256: row.sha256,
        byteSize: row.byteSize,
      },
    });
    return {
      image: {
        id: row.id,
        url: publicPostImageUrl(row.token),
        name: row.name,
        width: row.width,
        height: row.height,
        byteSize: row.byteSize,
        contentType: row.contentType,
      },
    };
  },
});
