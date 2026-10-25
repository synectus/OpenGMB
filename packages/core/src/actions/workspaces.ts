import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, postLanguages, reviewRequestCampaigns, workspaceReplySettings, workspaces } from "@opengmb/db";
import { AccessError, authorize, workspaceScope } from "../actor";
import { CoreError } from "../errors";
import { postLanguageInput } from "../posts/language";
import { DATE_FORMATS } from "../config/time-zones";
import { isValidTimeZone } from "../time/zones";
import { defineAction } from "../registry";

const workspaceOut = z.object({
  id: z.string(),
  name: z.string(),
  /** The language new posts start in. */
  defaultPostLanguage: postLanguageInput,
  /** IANA zone this client's times are shown and scheduled in, for example Asia/Kolkata. */
  timeZone: z.string(),
  /** default: never chosen; derived: from a location address; manual: saved by a person. */
  timeZoneSource: z.enum(["default", "derived", "manual"]),
  /** How dates are written for this client. */
  dateFormat: z.enum(DATE_FORMATS),
  /** Review request sender identity; legal name and postal address are required before the first send. */
  senderLegalName: z.string().nullable(),
  senderPostalAddress: z.string().nullable(),
  senderCompanyNumber: z.string().nullable(),
  senderPhone: z.string().nullable(),
  senderWebsite: z.string().nullable(),
  /** True for a HIPAA covered entity: no review requests, reply auto-approve locked off. */
  hipaaCoveredEntity: z.boolean(),
  createdAt: z.string(),
});

const toOut = (w: typeof workspaces.$inferSelect) => ({
  id: w.id,
  name: w.name,
  defaultPostLanguage: w.defaultPostLanguage,
  timeZone: w.timeZone,
  timeZoneSource: w.timeZoneSource,
  dateFormat: w.dateFormat,
  senderLegalName: w.senderLegalName,
  senderPostalAddress: w.senderPostalAddress,
  senderCompanyNumber: w.senderCompanyNumber,
  senderPhone: w.senderPhone,
  senderWebsite: w.senderWebsite,
  hipaaCoveredEntity: w.hipaaCoveredEntity,
  createdAt: w.createdAt.toISOString(),
});

type Tx = Parameters<Parameters<typeof defineAction>[0]["handler"]>[0]["tx"];

/** True when another client of the organization has this name, ignoring case ("test" and "Test" are one name). */
const nameTaken = async (tx: Tx, orgId: string, name: string, exceptId?: string) => {
  const [row] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.orgId, orgId),
        sql`lower(${workspaces.name}) = lower(${name})`,
        exceptId ? ne(workspaces.id, exceptId) : undefined,
      ),
    );
  return Boolean(row);
};

const loadClient = async (tx: Tx, orgId: string, workspaceId: string) => {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)));
  if (!row) throw new AccessError("NOT_FOUND", "Client not found");
  return row;
};

export const workspacesList = defineAction({
  name: "workspaces.list",
  description:
    "List the workspaces the caller can see in their organization, ordered by name, each with defaultPostLanguage (the language new posts start in), timeZone (IANA, the zone the client's times are shown and scheduled in), timeZoneSource and dateFormat.",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceOut) }),
  permission: "workspace:read",
  kind: "read",
  async handler({ tx, actor }) {
    const scope = workspaceScope(actor);
    const rows = await tx
      .select()
      .from(workspaces)
      .where(
        scope === "all"
          ? eq(workspaces.orgId, actor.orgId)
          : and(eq(workspaces.orgId, actor.orgId), inArray(workspaces.id, scope)),
      )
      .orderBy(asc(workspaces.name));
    return { workspaces: rows.map(toOut) };
  },
});

export const workspacesCreate = defineAction({
  name: "workspaces.create",
  description:
    "Create a workspace (shown as a client in the app) in the caller's organization. Names are unique per organization, ignoring upper and lower case.",
  input: z.object({ name: z.string().trim().min(1).max(100) }),
  output: z.object({ workspace: workspaceOut }),
  permission: "workspace:create",
  kind: "write",
  async preview({ readTx, actor }, input) {
    const [existing] = await readTx((tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.orgId, actor.orgId), sql`lower(${workspaces.name}) = lower(${input.name})`)),
    );
    return {
      summary: existing
        ? `Client "${input.name}" already exists; applying would fail with CONFLICT.`
        : `Would create client "${input.name}".`,
      diff: { before: null, after: { name: input.name } },
      findings: existing
        ? {
            ok: false,
            packs: [],
            violations: [
              {
                ruleId: "workspace.name_unique",
                packId: "universal",
                severity: "block",
                status: "active",
                message: `Client "${input.name}" already exists`,
                matches: [],
              },
            ],
          }
        : undefined,
    };
  },
  async handler({ tx, actor, audit }, input) {
    if (await nameTaken(tx, actor.orgId, input.name)) {
      throw new CoreError("CONFLICT", `Client "${input.name}" already exists`);
    }
    const [row] = await tx
      .insert(workspaces)
      .values({ orgId: actor.orgId, name: input.name })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new CoreError("CONFLICT", `Client "${input.name}" already exists`);
    await audit({
      action: "workspace.create",
      entityType: "workspace",
      entityId: row.id,
      before: null,
      after: row,
    });
    return { workspace: toOut(row) };
  },
});

export const workspacesSetPostLanguage = defineAction({
  name: "workspaces.setPostLanguage",
  description: `Set the language new posts in a workspace start in: posts.createDraft uses it when no language is given, and each post can still pick its own. language: one of ${postLanguages.join(", ")} (BCP 47). Existing posts keep their language. Needs review:configure (owner, admin).`,
  input: z.object({ workspaceId: z.uuid(), language: postLanguageInput }),
  output: z.object({ workspace: workspaceOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    const [before] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!before) throw new AccessError("NOT_FOUND", "Workspace not found");
    const [row] = await tx
      .update(workspaces)
      .set({ defaultPostLanguage: input.language })
      .where(eq(workspaces.id, before.id))
      .returning();
    await audit({
      action: "workspace.post_language_set",
      entityType: "workspace",
      entityId: before.id,
      before: { defaultPostLanguage: before.defaultPostLanguage },
      after: { defaultPostLanguage: row!.defaultPostLanguage },
    });
    return { workspace: toOut(row!) };
  },
});

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v ? v : null));

export const workspacesSetSenderIdentity = defineAction({
  name: "workspaces.setSenderIdentity",
  description:
    "Set who review request emails are from for a client: the business's legal name and postal address (both required, shown in the footer of every email, and review requests cannot be started or sent until both are set), and optionally a company or ABN number, phone and website. Pass all five fields; null clears an optional one. Needs review:configure (owner, admin).",
  input: z.object({
    workspaceId: z.uuid(),
    legalName: z.string().trim().min(2).max(200),
    postalAddress: z.string().trim().min(5).max(400),
    companyNumber: optionalText(60).default(null),
    phone: optionalText(40).default(null),
    website: optionalText(200).default(null),
  }),
  output: z.object({ workspace: workspaceOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    const before = await loadClient(tx, actor.orgId, input.workspaceId);
    const [row] = await tx
      .update(workspaces)
      .set({
        senderLegalName: input.legalName,
        senderPostalAddress: input.postalAddress,
        senderCompanyNumber: input.companyNumber,
        senderPhone: input.phone,
        senderWebsite: input.website,
      })
      .where(eq(workspaces.id, before.id))
      .returning();
    await audit({
      action: "workspace.sender_identity_set",
      entityType: "workspace",
      entityId: before.id,
      before: { senderLegalName: before.senderLegalName, senderPostalAddress: before.senderPostalAddress, senderCompanyNumber: before.senderCompanyNumber },
      after: { senderLegalName: row!.senderLegalName, senderPostalAddress: row!.senderPostalAddress, senderCompanyNumber: row!.senderCompanyNumber },
    });
    return { workspace: toOut(row!) };
  },
});

export const workspacesSetHipaa = defineAction({
  name: "workspaces.setHipaa",
  description:
    "Say whether the client's business is a HIPAA covered entity (for example a clinic that bills insurance electronically). When true: review requests are unavailable (a patient list would be protected health information; draft and running campaigns are cancelled), and reply auto-approve and auto-publish are switched off and cannot be turned on. Needs review:configure (owner, admin).",
  input: z.object({ workspaceId: z.uuid(), hipaaCoveredEntity: z.boolean() }),
  output: z.object({ workspace: workspaceOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    const before = await loadClient(tx, actor.orgId, input.workspaceId);
    const [row] = await tx
      .update(workspaces)
      .set({ hipaaCoveredEntity: input.hipaaCoveredEntity })
      .where(eq(workspaces.id, before.id))
      .returning();
    let cancelled = 0;
    if (input.hipaaCoveredEntity) {
      await tx
        .update(workspaceReplySettings)
        .set({ autoApproveMinStars: null, autoPublish: false, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(workspaceReplySettings.workspaceId, before.id));
      cancelled = (
        await tx
          .update(reviewRequestCampaigns)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(reviewRequestCampaigns.workspaceId, before.id), inArray(reviewRequestCampaigns.status, ["draft", "active"])))
          .returning({ id: reviewRequestCampaigns.id })
      ).length;
    }
    await audit({
      action: "workspace.hipaa_set",
      entityType: "workspace",
      entityId: before.id,
      before: { hipaaCoveredEntity: before.hipaaCoveredEntity },
      after: { hipaaCoveredEntity: row!.hipaaCoveredEntity, campaignsCancelled: cancelled },
    });
    return { workspace: toOut(row!) };
  },
});

export const workspacesSetTimeSettings = defineAction({
  name: "workspaces.setTimeSettings",
  description: `Set a workspace's time zone and date format. timeZone: an IANA zone such as Asia/Kolkata, America/Chicago or Australia/Sydney. dateFormat: one of ${DATE_FORMATS.join(", ")}. Times in the app, scheduled posts, recurring posts, report schedules and digests use the zone; stored times do not change. Pass only the fields to change. Needs review:configure (owner, admin).`,
  input: z
    .object({
      workspaceId: z.uuid(),
      timeZone: z.string().refine(isValidTimeZone, "Not a known IANA time zone").optional(),
      dateFormat: z.enum(DATE_FORMATS).optional(),
    })
    .refine((i) => i.timeZone !== undefined || i.dateFormat !== undefined, {
      message: "Pass timeZone or dateFormat",
    }),
  output: z.object({ workspace: workspaceOut }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    const [before] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!before) throw new AccessError("NOT_FOUND", "Workspace not found");
    const [row] = await tx
      .update(workspaces)
      .set({
        ...(input.timeZone !== undefined ? { timeZone: input.timeZone, timeZoneSource: "manual" as const } : {}),
        ...(input.dateFormat !== undefined ? { dateFormat: input.dateFormat, dateFormatSource: "manual" as const } : {}),
      })
      .where(eq(workspaces.id, before.id))
      .returning();
    await audit({
      action: "workspace.time_settings_set",
      entityType: "workspace",
      entityId: before.id,
      before: { timeZone: before.timeZone, dateFormat: before.dateFormat },
      after: { timeZone: row!.timeZone, dateFormat: row!.dateFormat },
    });
    return { workspace: toOut(row!) };
  },
});

export const workspacesRename = defineAction({
  name: "workspaces.rename",
  description:
    "Rename a workspace (shown as a client in the app). Names are unique per organization, ignoring upper and lower case; changing only the casing of its own name is allowed. Needs workspace:manage (owner, admin).",
  input: z.object({ workspaceId: z.uuid(), name: z.string().trim().min(1).max(100) }),
  output: z.object({ workspace: workspaceOut }),
  permission: "workspace:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const before = await loadClient(tx, actor.orgId, input.workspaceId);
    if (await nameTaken(tx, actor.orgId, input.name, before.id)) {
      throw new CoreError("CONFLICT", `Client "${input.name}" already exists`);
    }
    const [row] = await tx
      .update(workspaces)
      .set({ name: input.name })
      .where(eq(workspaces.id, before.id))
      .returning();
    await audit({
      action: "workspace.rename",
      entityType: "workspace",
      entityId: before.id,
      before: { name: before.name },
      after: { name: row!.name },
    });
    return { workspace: toOut(row!) };
  },
});

export const workspacesDelete = defineAction({
  name: "workspaces.delete",
  description:
    "Delete a workspace (a client in the app). Refused with CONFLICT while the client has any location, and while anything else still belongs to it (people, posts, reports, templates); remove those first. Its reply settings are deleted with it. Needs workspace:manage (owner, admin).",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  permission: "workspace:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const w = await loadClient(tx, actor.orgId, input.workspaceId);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(locations)
      .where(eq(locations.workspaceId, w.id));
    if (count!.n > 0) {
      throw new CoreError(
        "CONFLICT",
        `Client "${w.name}" still has ${count!.n} ${count!.n === 1 ? "location" : "locations"}. Remove or move them first.`,
      );
    }
    try {
      // A savepoint: if something still points at the client, the reply-settings delete rolls back too.
      await tx.transaction(async (sp) => {
        await sp.delete(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, w.id));
        await sp.delete(workspaces).where(eq(workspaces.id, w.id));
      });
    } catch (e) {
      if ((e as { code?: string; cause?: { code?: string } }).code === "23503" || (e as { cause?: { code?: string } }).cause?.code === "23503") {
        throw new CoreError(
          "CONFLICT",
          `Client "${w.name}" still has people, posts, reports or templates. Remove those first.`,
        );
      }
      throw e;
    }
    await audit({
      action: "workspace.delete",
      entityType: "workspace",
      entityId: w.id,
      before: w,
      after: null,
    });
    return { deleted: true };
  },
});
