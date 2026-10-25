import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { locations, replyTemplates, workspaces, type Tx } from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { REPLY_MAX_BYTES } from "../config/google-limits";
import { CoreError } from "../errors";
import { defineAction } from "../registry";
import { getReviewRow } from "../reviews/queries";
import {
  isGenericTemplate,
  renderTemplate,
  reviewerFirstName,
  TEMPLATE_VARIABLES,
  validateTemplateBody,
} from "../reviews/templates";
import { getWorkspaceReplySettings } from "../reviews/workspace-settings";

const templateOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  body: z.string(),
  generic: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const toOut = (t: typeof replyTemplates.$inferSelect): z.input<typeof templateOut> => ({
  id: t.id,
  workspaceId: t.workspaceId,
  name: t.name,
  body: t.body,
  generic: t.generic,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const nameSchema = z.string().trim().min(1).max(100);
const bodySchema = z.string().trim().min(1).max(REPLY_MAX_BYTES);
const variablesHelp = TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ");

async function loadTemplate(tx: Tx, actor: Actor, id: string) {
  const [t] = await tx
    .select()
    .from(replyTemplates)
    .where(and(eq(replyTemplates.id, id), eq(replyTemplates.orgId, actor.orgId)));
  if (!t) throw new AccessError("NOT_FOUND", "Template not found");
  return t;
}

export const replyTemplatesList = defineAction({
  name: "replyTemplates.list",
  description: `List a workspace's reply templates, ordered by name. generic is true when the body uses no reviewer-specific variable ({reviewer_first_name}); healthcare workspaces can only render generic templates. Variables: ${variablesHelp}.`,
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ templates: z.array(templateOut) }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:read", { workspaceId: input.workspaceId });
    const rows = await tx
      .select()
      .from(replyTemplates)
      .where(
        and(
          eq(replyTemplates.orgId, actor.orgId),
          eq(replyTemplates.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(replyTemplates.name));
    return { templates: rows.map(toOut) };
  },
});

export const replyTemplatesCreate = defineAction({
  name: "replyTemplates.create",
  description: `Create a reply template in a workspace. Names are unique per workspace. The body may use only ${variablesHelp}; any other {variable} is INVALID_INPUT. generic is computed from the body. Needs review:configure (owner, admin).`,
  input: z.object({ workspaceId: z.uuid(), name: nameSchema, body: bodySchema }),
  output: z.object({ template: templateOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    validateTemplateBody(input.body);
    const [w] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
    const [row] = await tx
      .insert(replyTemplates)
      .values({
        orgId: actor.orgId,
        workspaceId: input.workspaceId,
        name: input.name,
        body: input.body,
        generic: isGenericTemplate(input.body),
        createdBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new CoreError("CONFLICT", `Template "${input.name}" already exists`);
    await audit({
      action: "reply_template.create",
      entityType: "reply_template",
      entityId: row.id,
      before: null,
      after: row,
    });
    return { template: toOut(row) };
  },
});

export const replyTemplatesUpdate = defineAction({
  name: "replyTemplates.update",
  description: `Rename a reply template and/or change its body (same variable rules as replyTemplates.create: only ${variablesHelp}). generic is recomputed. Needs review:configure (owner, admin).`,
  input: z.object({ id: z.uuid(), name: nameSchema.optional(), body: bodySchema.optional() }),
  output: z.object({ template: templateOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadTemplate(tx, actor, input.id);
    authorize(actor, "review:configure", { workspaceId: before.workspaceId });
    const name = input.name ?? before.name;
    const body = input.body ?? before.body;
    validateTemplateBody(body);
    if (name !== before.name) {
      const [dup] = await tx
        .select({ id: replyTemplates.id })
        .from(replyTemplates)
        .where(
          and(eq(replyTemplates.workspaceId, before.workspaceId), eq(replyTemplates.name, name)),
        );
      if (dup) throw new CoreError("CONFLICT", `Template "${name}" already exists`);
    }
    const [row] = await tx
      .update(replyTemplates)
      .set({ name, body, generic: isGenericTemplate(body), updatedAt: new Date() })
      .where(eq(replyTemplates.id, before.id))
      .returning();
    await audit({
      action: "reply_template.update",
      entityType: "reply_template",
      entityId: before.id,
      before,
      after: row,
    });
    return { template: toOut(row!) };
  },
});

export const replyTemplatesDelete = defineAction({
  name: "replyTemplates.delete",
  description: "Delete a reply template. Needs review:configure (owner, admin).",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadTemplate(tx, actor, input.id);
    authorize(actor, "review:configure", { workspaceId: before.workspaceId });
    await tx.delete(replyTemplates).where(eq(replyTemplates.id, before.id));
    await audit({
      action: "reply_template.delete",
      entityType: "reply_template",
      entityId: before.id,
      before,
      after: null,
    });
    return { id: before.id };
  },
});

export const replyTemplatesRender = defineAction({
  name: "replyTemplates.render",
  description: `Render a reply template for a review and return the text only (nothing is saved or published; use it as a draft body, guardrails still apply). {reviewer_first_name} is the first word of the reviewer's name (error "reviewer name unavailable" for anonymous reviewers), {location_name} the location's title, {phone} its phone number (error naming the variable if missing). In a workspace with generic-templates-only (healthcare profile), non-generic templates are FORBIDDEN. The template and review must be in the same workspace.`,
  input: z.object({ templateId: z.uuid(), reviewId: z.uuid() }),
  output: z.object({ body: z.string() }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    const template = await loadTemplate(tx, actor, input.templateId);
    authorize(actor, "review:draft", { workspaceId: template.workspaceId });
    const review = await getReviewRow(tx, actor, input.reviewId);
    if (!review) throw new AccessError("NOT_FOUND", "Review not found");
    if (review.workspaceId !== template.workspaceId) {
      throw new CoreError("INVALID_INPUT", "Template and review are in different workspaces");
    }
    const settings = await getWorkspaceReplySettings(tx, review.workspaceId);
    if (settings.genericTemplatesOnly && !template.generic) {
      throw new CoreError("FORBIDDEN", "Healthcare profile allows generic templates only");
    }
    const [loc] = await tx
      .select({ name: locations.name, title: locations.title, phone: locations.phone })
      .from(locations)
      .where(and(eq(locations.id, review.locationId), eq(locations.orgId, actor.orgId)));
    return {
      body: renderTemplate(template.body, {
        reviewer_first_name: reviewerFirstName(
          review.reviewerDisplayName,
          review.reviewerIsAnonymous,
        ),
        location_name: loc?.title ?? loc?.name ?? review.locationName,
        phone: loc?.phone,
      }),
    };
  },
});
