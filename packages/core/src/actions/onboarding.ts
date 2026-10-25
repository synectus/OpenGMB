import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@opengmb/db";
import { authorize } from "../actor";
import { defineAction } from "../registry";

export const onboardingGet = defineAction({
  name: "onboarding.get",
  description: "Whether the first-run checklist facts stored on the organization are set: healthReportSeen (someone opened a location's health report) and dismissed (an owner or admin hid the checklist).",
  input: z.object({}),
  output: z.object({ healthReportSeen: z.boolean(), dismissed: z.boolean() }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }) {
    const [o] = await tx
      .select({ seen: organizations.healthReportSeenAt, dismissed: organizations.setupDismissedAt })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    return { healthReportSeen: o?.seen != null, dismissed: o?.dismissed != null };
  },
});

export const onboardingUpdate = defineAction({
  name: "onboarding.update",
  description:
    "Keep the first-run checklist on Home honest. healthReportSeen true records that someone opened a location's health report (it stays on). dismissed true hides the checklist for the whole organization, false brings it back; dismissing needs google:manage (owner, admin). Pass only the fields to change. Writes nothing to Google.",
  input: z.object({ healthReportSeen: z.literal(true).optional(), dismissed: z.boolean().optional() }),
  output: z.object({ healthReportSeen: z.boolean(), dismissed: z.boolean() }),
  permission: "location:manage",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    if (input.dismissed !== undefined) authorize(actor, "google:manage");
    const [before] = await tx
      .select({ seen: organizations.healthReportSeenAt, dismissed: organizations.setupDismissedAt })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    const now = new Date();
    const patch: Partial<typeof organizations.$inferInsert> = {};
    if (input.healthReportSeen && !before?.seen) patch.healthReportSeenAt = now;
    if (input.dismissed !== undefined && (input.dismissed !== (before?.dismissed != null)))
      patch.setupDismissedAt = input.dismissed ? now : null;
    if (Object.keys(patch).length > 0)
      await tx.update(organizations).set(patch).where(eq(organizations.id, actor.orgId));
    const after = {
      healthReportSeen: patch.healthReportSeenAt !== undefined || before?.seen != null,
      dismissed: "setupDismissedAt" in patch ? patch.setupDismissedAt !== null : before?.dismissed != null,
    };
    await audit({
      action: "onboarding.update",
      entityType: "organization",
      entityId: actor.orgId,
      before: { healthReportSeen: before?.seen != null, dismissed: before?.dismissed != null },
      after,
    });
    return after;
  },
});
