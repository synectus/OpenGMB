import { and, asc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { postImages, postTemplates, postTemplateTypes, users } from "@opengmb/db";
import { AccessError } from "../actor";
import { CoreError } from "../errors";
import { ctaInput, offerInput } from "../posts/content";
import { postLanguageInput } from "../posts/language";
import { canManageLibrary, publicPostImageUrl, requireWorkspace } from "../postImages/store";
import { defineAction } from "../registry";

const shape = {
  name: z.string().trim().min(1).max(120),
  topicType: z.enum(postTemplateTypes),
  language: postLanguageInput,
  summary: z.string().max(20_000).default(""),
  cta: ctaInput.nullish(),
  eventTitle: z.string().max(300).nullish(),
  offer: offerInput.nullish(),
  imageId: z.uuid().nullish(),
};

const templateOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  topicType: z.enum(postTemplateTypes),
  language: z.string(),
  summary: z.string(),
  cta: z.object({ actionType: z.string(), url: z.string().nullish() }).nullable(),
  eventTitle: z.string().nullable(),
  offer: z
    .object({
      couponCode: z.string().nullish(),
      redeemOnlineUrl: z.string().nullish(),
      termsConditions: z.string().nullish(),
    })
    .nullable(),
  image: z.object({ id: z.string(), name: z.string(), url: z.string() }).nullable(),
  updatedAt: z.string(),
  updatedByName: z.string(),
});
const listOut = z.object({ templates: z.array(templateOut), can: z.object({ manage: z.boolean() }) });

async function hydrate(tx: Parameters<typeof requireWorkspace>[0], where: SQL | undefined) {
  const rows = await tx
    .select({
      t: postTemplates,
      imgName: postImages.name,
      imgToken: postImages.token,
      by: users.name,
    })
    .from(postTemplates)
    .innerJoin(users, eq(users.id, postTemplates.updatedBy))
    .leftJoin(postImages, eq(postImages.id, postTemplates.imageId))
    .where(where)
    .orderBy(asc(postTemplates.name));
  return rows.map(({ t, imgName, imgToken, by }): z.input<typeof templateOut> => ({
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    topicType: t.topicType,
    language: t.language,
    summary: t.summary,
    cta: (t.cta as z.input<typeof templateOut>["cta"]) ?? null,
    eventTitle: t.eventTitle,
    offer: (t.offer as z.input<typeof templateOut>["offer"]) ?? null,
    image:
      t.imageId && imgName !== null && imgToken !== null
        ? { id: t.imageId, name: imgName, url: publicPostImageUrl(imgToken) }
        : null,
    updatedAt: t.updatedAt.toISOString(),
    updatedByName: by,
  }));
}

/** The image must be in the same workspace; anything else is INVALID_INPUT. */
async function checkImage(tx: Parameters<typeof requireWorkspace>[0], workspaceId: string, imageId?: string | null) {
  if (!imageId) return;
  const [img] = await tx
    .select({ id: postImages.id })
    .from(postImages)
    .where(and(eq(postImages.id, imageId), eq(postImages.workspaceId, workspaceId)));
  if (!img) throw new CoreError("INVALID_INPUT", "Image is not in this workspace's library");
}

async function checkName(
  tx: Parameters<typeof requireWorkspace>[0],
  workspaceId: string,
  name: string,
  exceptId?: string,
) {
  const rows = await tx
    .select({ id: postTemplates.id })
    .from(postTemplates)
    .where(and(eq(postTemplates.workspaceId, workspaceId), eq(postTemplates.name, name)));
  if (rows.some((r) => r.id !== exceptId)) {
    throw new CoreError("CONFLICT", "A template with this name already exists");
  }
}

export const postTemplatesList = defineAction({
  name: "postTemplates.list",
  description:
    "List a workspace's post templates (name order). A template holds a post type (STANDARD, EVENT or OFFER), language, text, call to action, event title, offer fields and one library image; it has no locations, send time or event dates. To post from one, read it and call posts.createDraft with its content (a post made from a template is an ordinary draft).",
  input: z.object({ workspaceId: z.uuid() }),
  output: listOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:read");
    const templates = await hydrate(
      tx,
      and(eq(postTemplates.orgId, actor.orgId), eq(postTemplates.workspaceId, input.workspaceId)),
    );
    return { templates, can: { manage: canManageLibrary(actor) } };
  },
});

export const postTemplatesGet = defineAction({
  name: "postTemplates.get",
  description: "Get one post template by id.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ template: templateOut }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const [t] = await hydrate(tx, and(eq(postTemplates.id, input.id), eq(postTemplates.orgId, actor.orgId)));
    if (!t) throw new AccessError("NOT_FOUND", "Template not found");
    await requireWorkspace(tx, actor, t.workspaceId, "review:read");
    return { template: t };
  },
});

export const postTemplatesCreate = defineAction({
  name: "postTemplates.create",
  description:
    "Create a post template in a workspace. Names are unique per workspace (CONFLICT otherwise). imageId must be an image from postImages.list. Needs review:draft (owner, admin, manager).",
  input: z.object({ workspaceId: z.uuid(), ...shape }),
  output: z.object({ template: templateOut }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
    await checkName(tx, input.workspaceId, input.name);
    await checkImage(tx, input.workspaceId, input.imageId);
    const [row] = await tx
      .insert(postTemplates)
      .values({
        orgId: actor.orgId,
        workspaceId: input.workspaceId,
        name: input.name,
        topicType: input.topicType,
        language: input.language,
        summary: input.summary,
        cta: input.cta ?? null,
        eventTitle: input.eventTitle ?? null,
        offer: input.topicType === "OFFER" ? (input.offer ?? null) : null,
        imageId: input.imageId ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: postTemplates.id });
    await audit({
      action: "post_template.created",
      entityType: "post_template",
      entityId: row!.id,
      after: { workspaceId: input.workspaceId, topicType: input.topicType, language: input.language, summaryLength: Array.from(input.summary).length },
    });
    const [t] = await hydrate(tx, eq(postTemplates.id, row!.id));
    return { template: t! };
  },
});

export const postTemplatesUpdate = defineAction({
  name: "postTemplates.update",
  description:
    "Replace a post template's content (send every field; imageId null removes the image). Posts already made from it are not changed. Needs review:draft.",
  input: z.object({ id: z.uuid(), ...shape }),
  output: z.object({ template: templateOut }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [cur] = await tx
      .select()
      .from(postTemplates)
      .where(and(eq(postTemplates.id, input.id), eq(postTemplates.orgId, actor.orgId)));
    if (!cur) throw new AccessError("NOT_FOUND", "Template not found");
    await requireWorkspace(tx, actor, cur.workspaceId, "review:draft");
    await checkName(tx, cur.workspaceId, input.name, cur.id);
    await checkImage(tx, cur.workspaceId, input.imageId);
    await tx
      .update(postTemplates)
      .set({
        name: input.name,
        topicType: input.topicType,
        language: input.language,
        summary: input.summary,
        cta: input.cta ?? null,
        eventTitle: input.eventTitle ?? null,
        offer: input.topicType === "OFFER" ? (input.offer ?? null) : null,
        imageId: input.imageId ?? null,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(postTemplates.id, cur.id));
    await audit({
      action: "post_template.updated",
      entityType: "post_template",
      entityId: cur.id,
      after: { workspaceId: cur.workspaceId, topicType: input.topicType, language: input.language, summaryLength: Array.from(input.summary).length },
    });
    const [t] = await hydrate(tx, eq(postTemplates.id, cur.id));
    return { template: t! };
  },
});

export const postTemplatesDelete = defineAction({
  name: "postTemplates.delete",
  description: "Delete a post template. Posts already made from it are not affected. Needs review:draft.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.literal(true) }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [cur] = await tx
      .select({ id: postTemplates.id, workspaceId: postTemplates.workspaceId })
      .from(postTemplates)
      .where(and(eq(postTemplates.id, input.id), eq(postTemplates.orgId, actor.orgId)));
    if (!cur) throw new AccessError("NOT_FOUND", "Template not found");
    await requireWorkspace(tx, actor, cur.workspaceId, "review:draft");
    await tx.delete(postTemplates).where(eq(postTemplates.id, cur.id));
    await audit({
      action: "post_template.deleted",
      entityType: "post_template",
      entityId: cur.id,
      after: { workspaceId: cur.workspaceId },
    });
    return { deleted: true as const };
  },
});
