import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { locations, suspensionCases, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { SUSPENSION_CHECKLIST } from "../config/suspension";
import { CoreError } from "../errors";
import type { GoogleVerification } from "../google/client";
import { clientForLocation, googleNames, loadLocation } from "../locationOps/access";
import { defineAction } from "../registry";
import { STANDINGS, describeVoiceOfMerchant } from "../verification/state";

export const verificationState = defineAction({
  name: "verification.state",
  description:
    "A location's verification state live from Google (outside any transaction): Voice of Merchant (hasVoiceOfMerchant = in good standing and in control of the listing; hasBusinessAuthority = ownership), which action Google wants next (standing: good_standing, wait_for_review, verify, comply_with_guidelines = fix guideline problems, resolve_ownership_conflict = duplicate of a location in good standing, unknown) with the recommendation reason, and the location's verification attempts (method, PENDING / COMPLETED / FAILED). Read only: OpenGMB starts no verification and submits no appeal; those are manual.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    standing: z.enum(STANDINGS),
    hasVoiceOfMerchant: z.boolean(),
    hasBusinessAuthority: z.boolean(),
    waitForVoiceOfMerchant: z.boolean(),
    needsVerification: z.boolean(),
    hasPendingVerification: z.boolean(),
    complyWithGuidelines: z.boolean(),
    recommendationReason: z.string().nullable(),
    resolveOwnershipConflict: z.boolean(),
    verifications: z.array(
      z.object({
        name: z.string(),
        method: z.string().nullable(),
        state: z.string().nullable(),
        createTime: z.string().nullable(),
      }),
    ),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    const { locationName } = googleNames(loc);
    const state = describeVoiceOfMerchant(await client.getVoiceOfMerchantState(locationName));
    const all: GoogleVerification[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await client.listVerifications(locationName, {
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      all.push(...res.verifications);
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return {
      location: { id: loc.id, name: loc.name, workspaceId: loc.workspaceId },
      ...state,
      verifications: all.map((v) => ({
        name: v.name,
        method: v.method ?? null,
        state: v.state ?? null,
        createTime: v.createTime ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Suspension cases
// ---------------------------------------------------------------------------

const statusOut = z.enum(["open", "appealed", "reinstated", "closed_lost"]);
const checklistItem = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
  note: z.string(),
});
type ChecklistItem = z.infer<typeof checklistItem>;

const caseOut = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  workspaceId: z.string(),
  openedAt: z.string(),
  reason: z.string(),
  status: statusOut,
  appealSubmittedAt: z.string().nullable(),
  outcomeAt: z.string().nullable(),
  outcomeNotes: z.string().nullable(),
  evidenceChecklist: z.array(checklistItem),
  checklistDone: z.number().int(),
  checklistTotal: z.number().int(),
  createdBy: z.string(),
  updatedAt: z.string(),
});

/** open -> appealed | reinstated | closed_lost; appealed -> reinstated | closed_lost (Google allows one appeal). */
export const SUSPENSION_TRANSITIONS: Record<z.infer<typeof statusOut>, readonly string[]> = {
  open: ["appealed", "reinstated", "closed_lost"],
  appealed: ["reinstated", "closed_lost"],
  reinstated: [],
  closed_lost: [],
};

type CaseRow = typeof suspensionCases.$inferSelect;
const iso = (d: Date | null) => d?.toISOString() ?? null;

function toOut(r: CaseRow, loc: { name: string; workspaceId: string }): z.input<typeof caseOut> {
  const items = r.evidenceChecklist as ChecklistItem[];
  return {
    id: r.id,
    locationId: r.locationId,
    locationName: loc.name,
    workspaceId: loc.workspaceId,
    openedAt: r.openedAt.toISOString(),
    reason: r.reason,
    status: r.status,
    appealSubmittedAt: iso(r.appealSubmittedAt),
    outcomeAt: iso(r.outcomeAt),
    outcomeNotes: r.outcomeNotes,
    evidenceChecklist: items,
    checklistDone: items.filter((i) => i.done).length,
    checklistTotal: items.length,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export const suspensionCasesList = defineAction({
  name: "suspension.cases.list",
  description:
    "Suspension / reinstatement cases the caller can see, newest first, with the evidence checklist (business registration, licence, tax certificate, utility bill, storefront / signage / interior photos, video walkthrough, website match ...), dates (opened, appeal submitted, outcome) and status (open, appealed, reinstated, closed_lost). Filters: locationId, workspaceId, status. This is a record-keeping tool for a manual process: nothing is sent to Google.",
  input: z.object({
    locationId: z.uuid().optional(),
    workspaceId: z.uuid().optional(),
    status: statusOut.optional(),
  }),
  output: z.object({ cases: z.array(caseOut) }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const rows = await tx
      .select({ c: suspensionCases, name: locations.name, workspaceId: locations.workspaceId })
      .from(suspensionCases)
      .innerJoin(locations, eq(locations.id, suspensionCases.locationId))
      .where(
        and(
          eq(suspensionCases.orgId, actor.orgId),
          scope === "all" ? undefined : inArray(locations.workspaceId, scope),
          input.workspaceId ? eq(locations.workspaceId, input.workspaceId) : undefined,
          input.locationId ? eq(suspensionCases.locationId, input.locationId) : undefined,
          input.status ? eq(suspensionCases.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(suspensionCases.openedAt), desc(suspensionCases.id));
    return { cases: rows.map((r) => toOut(r.c, { name: r.name, workspaceId: r.workspaceId })) };
  },
});

export const suspensionCasesCreate = defineAction({
  name: "suspension.cases.create",
  description:
    "Open a suspension case for a location: the reason (what Google said or what you see), when it started (openedAt, default now) and a fresh evidence checklist. Records only; nothing is sent to Google. Needs profile:edit.",
  input: z.object({
    locationId: z.uuid(),
    reason: z.string().trim().min(1).max(4_000),
    openedAt: z.iso.datetime({ offset: true }).optional(),
  }),
  output: z.object({ case: caseOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    const [row] = await tx
      .insert(suspensionCases)
      .values({
        orgId: actor.orgId,
        locationId: loc.id,
        reason: input.reason,
        ...(input.openedAt ? { openedAt: new Date(input.openedAt) } : {}),
        evidenceChecklist: SUSPENSION_CHECKLIST.map((i) => ({
          key: i.key,
          label: i.label,
          done: false,
          note: "",
        })),
        createdBy: actor.userId,
      })
      .returning();
    await audit({
      action: "suspension.case_created",
      entityType: "suspension_case",
      entityId: row!.id,
      after: { locationId: loc.id, status: "open", reasonLength: input.reason.length },
    });
    return { case: toOut(row!, loc) };
  },
});

async function loadCase(tx: Tx, actor: Actor, id: string, permission: "profile:edit") {
  const [row] = await tx
    .select({ c: suspensionCases, name: locations.name, workspaceId: locations.workspaceId })
    .from(suspensionCases)
    .innerJoin(locations, eq(locations.id, suspensionCases.locationId))
    .where(and(eq(suspensionCases.id, id), eq(suspensionCases.orgId, actor.orgId)))
    .for("update", { of: suspensionCases });
  const scope = workspaceScope(actor);
  if (!row || (scope !== "all" && !scope.includes(row.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Case not found");
  }
  authorize(actor, permission, { workspaceId: row.workspaceId });
  return row;
}

export const suspensionCasesUpdate = defineAction({
  name: "suspension.cases.update",
  description:
    "Update a suspension case. checklist: [{ key, done?, note? }] toggles items and sets notes (keys as in suspension.cases.list; unknown keys are rejected). status: open -> appealed (sets appealSubmittedAt, default now) -> reinstated or closed_lost (sets outcomeAt, default now); open may also go straight to reinstated or closed_lost. Google allows one appeal, so there is no second appeal. appealSubmittedAt can be corrected while appealed; outcomeAt and outcomeNotes can be set with the outcome and outcomeNotes edited after it; a finished case is otherwise read only. reason can be reworded while the case is open or appealed. Records only; nothing is sent to Google. Needs profile:edit.",
  input: z.object({
    id: z.uuid(),
    status: statusOut.optional(),
    reason: z.string().trim().min(1).max(4_000).optional(),
    appealSubmittedAt: z.iso.datetime({ offset: true }).optional(),
    outcomeAt: z.iso.datetime({ offset: true }).optional(),
    outcomeNotes: z.string().max(4_000).optional(),
    checklist: z
      .array(
        z.object({
          key: z.string().min(1).max(100),
          done: z.boolean().optional(),
          note: z.string().max(1_000).optional(),
        }),
      )
      .max(50)
      .optional(),
  }),
  output: z.object({ case: caseOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const { c, name, workspaceId } = await loadCase(tx, actor, input.id, "profile:edit");
    const finished = c.status === "reinstated" || c.status === "closed_lost";
    const to = input.status;
    if (to && to !== c.status && !SUSPENSION_TRANSITIONS[c.status].includes(to)) {
      throw new CoreError("CONFLICT", `A ${c.status} case cannot move to ${to}`);
    }
    const finishing = to === "reinstated" || to === "closed_lost";
    if (finished && (input.reason || input.checklist || input.appealSubmittedAt || to)) {
      throw new CoreError(
        "CONFLICT",
        "A finished case can only get outcome notes and an outcome date",
      );
    }
    if (!finished && !finishing && (input.outcomeAt || input.outcomeNotes !== undefined)) {
      throw new CoreError(
        "INVALID_INPUT",
        "An outcome can only be recorded when the case is finished",
      );
    }
    if (input.appealSubmittedAt && !(to === "appealed" || c.status === "appealed")) {
      throw new CoreError("INVALID_INPUT", "appealSubmittedAt needs the case to be appealed");
    }
    const items = (c.evidenceChecklist as ChecklistItem[]).map((i) => ({ ...i }));
    const touched: string[] = [];
    for (const upd of input.checklist ?? []) {
      const item = items.find((i) => i.key === upd.key);
      if (!item) throw new CoreError("INVALID_INPUT", `Unknown checklist item ${upd.key}`);
      if (upd.done !== undefined) item.done = upd.done;
      if (upd.note !== undefined) item.note = upd.note;
      touched.push(upd.key);
    }
    const now = new Date();
    const appealAt =
      c.status === "open" && to === "appealed"
        ? new Date(input.appealSubmittedAt ?? now)
        : c.status === "appealed" && input.appealSubmittedAt
          ? new Date(input.appealSubmittedAt)
          : null;
    const outcomeAt =
      finishing || (finished && input.outcomeAt) ? new Date(input.outcomeAt ?? now) : null;
    const set: Partial<typeof suspensionCases.$inferInsert> = {
      updatedAt: now,
      evidenceChecklist: items,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(appealAt ? { appealSubmittedAt: appealAt } : {}),
      ...(outcomeAt ? { outcomeAt } : {}),
      ...(input.outcomeNotes !== undefined ? { outcomeNotes: input.outcomeNotes } : {}),
      ...(to && to !== c.status ? { status: to } : {}),
    };
    const [row] = await tx
      .update(suspensionCases)
      .set(set)
      .where(and(eq(suspensionCases.id, c.id), eq(suspensionCases.status, c.status)))
      .returning();
    if (!row) throw new CoreError("CONFLICT", "Case changed while it was being updated");
    await audit({
      action: "suspension.case_updated",
      entityType: "suspension_case",
      entityId: row.id,
      before: { status: c.status },
      after: {
        status: row.status,
        locationId: row.locationId,
        checklistKeys: touched.sort(),
        checklistDone: items.filter((i) => i.done).length,
        ...(input.outcomeNotes !== undefined
          ? { outcomeNotesLength: input.outcomeNotes.length }
          : {}),
      },
    });
    return { case: toOut(row, { name, workspaceId }) };
  },
});
