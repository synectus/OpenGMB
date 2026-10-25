import { eq } from "drizzle-orm";
import { z } from "zod";
import { orgBranding } from "@opengmb/db";
import { hexColor, httpsUrl, loadBranding } from "../branding";
import { authorize } from "../actor";
import { defineAction } from "../registry";
import { assertWorkspaceInOrg, deleteLogo, logoIdsFor, orgUsage } from "../storage/store";

const brandingOut = z.object({
  agencyName: z.string(),
  logoUrl: z.string().nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
});

export const brandingGet = defineAction({
  name: "branding.get",
  description:
    "The caller's organization branding: agencyName (falls back to the organization name), logoUrl (https), primaryColor and accentColor (#rrggbb). Any member can read it; the app and emails use it.",
  input: z.object({}),
  output: z.object({ branding: brandingOut }),
  permission: "workspace:read",
  kind: "read",
  async handler({ tx, actor }) {
    return { branding: await loadBranding(tx, actor.orgId) };
  },
});

export const brandingUpdate = defineAction({
  name: "branding.update",
  description:
    "Set the organization's branding (owner, admin). Every field is optional and null clears it: agencyName (1-100 chars), logoUrl (https URL only; a logo file uploaded in the web app wins over it in the app, see branding.logos), primaryColor and accentColor (#rrggbb). Fields you leave out are unchanged.",
  input: z.object({
    agencyName: z.string().trim().min(1).max(100).nullable().optional(),
    logoUrl: httpsUrl.nullable().optional(),
    primaryColor: hexColor.nullable().optional(),
    accentColor: hexColor.nullable().optional(),
  }),
  output: z.object({ branding: brandingOut }),
  permission: "branding:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [before] = await tx.select().from(orgBranding).where(eq(orgBranding.orgId, actor.orgId));
    const set = {
      ...(input.agencyName !== undefined ? { agencyName: input.agencyName } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.primaryColor !== undefined ? { primaryColor: input.primaryColor } : {}),
      ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
      updatedAt: new Date(),
      updatedBy: actor.userId,
    };
    const [after] = await tx
      .insert(orgBranding)
      .values({ orgId: actor.orgId, ...set })
      .onConflictDoUpdate({ target: orgBranding.orgId, set })
      .returning();
    await audit({
      action: "branding.update",
      entityType: "org_branding",
      entityId: actor.orgId,
      before: before ?? null,
      after,
    });
    return { branding: await loadBranding(tx, actor.orgId) };
  },
});

export const brandingLogos = defineAction({
  name: "branding.logos",
  description:
    "The uploaded logo files the caller may see: orgLogoFileId (the agency logo, or null) and workspaceLogos (one per client in the caller's scope that has one). A file is shown at /api/files/<fileId>. An uploaded logo wins over the logoUrl link. Logos are uploaded in the web app (Settings, Branding); agents cannot upload.",
  input: z.object({}),
  output: z.object({
    orgLogoFileId: z.string().nullable(),
    workspaceLogos: z.array(z.object({ workspaceId: z.string(), fileId: z.string() })),
  }),
  permission: "workspace:read",
  kind: "read",
  async handler({ tx, actor }) {
    return logoIdsFor(tx, actor);
  },
});

export const brandingRemoveLogo = defineAction({
  name: "branding.removeLogo",
  description:
    "Delete an uploaded logo file (owner, admin): the agency logo, or one client's when workspaceId is given. Frees its storage. Returns removed false when there was none.",
  input: z.object({ workspaceId: z.uuid().optional() }),
  output: z.object({ removed: z.boolean() }),
  permission: "branding:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const workspaceId = input.workspaceId ?? null;
    authorize(actor, "branding:manage", workspaceId ? { workspaceId } : {});
    if (workspaceId) await assertWorkspaceInOrg(tx, actor.orgId, workspaceId);
    const removed = await deleteLogo(tx, actor.orgId, workspaceId);
    await audit({
      action: "storage.logo_removed",
      entityType: "stored_file",
      entityId: workspaceId ?? actor.orgId,
      before: { workspaceId },
      after: { removed },
    });
    return { removed };
  },
});

export const storageUsage = defineAction({
  name: "storage.usage",
  description:
    "How much of the organization's file storage is used (owner, admin): usedBytes, limitBytes (the per-organization allowance, 50 MB unless the server sets STORAGE_QUOTA_MB) and a breakdown by store: storedFiles (logos), postImages (the post image library), mediaUploads (photo uploads not yet sent to Google) and reportPdfs. An upload that would pass the limit is refused.",
  input: z.object({}),
  output: z.object({
    usedBytes: z.number().int(),
    limitBytes: z.number().int(),
    breakdown: z.object({
      storedFiles: z.number().int(),
      postImages: z.number().int(),
      mediaUploads: z.number().int(),
      reportPdfs: z.number().int(),
    }),
  }),
  permission: "branding:manage",
  kind: "read",
  async handler({ tx, actor }) {
    return orgUsage(tx, actor.orgId);
  },
});
