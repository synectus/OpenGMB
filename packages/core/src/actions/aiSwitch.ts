import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations, users, type Tx } from "@opengmb/db";
import { assertHumanBillingCaller } from "../billing";
import { defineAction } from "../registry";

const state = z.object({
  /** False while an owner has switched AI features off for the whole account. */
  aiEnabled: z.boolean(),
  /** The caller has already seen the one-time notice about what AI features send to Anthropic. */
  noticeSeen: z.boolean(),
});

async function read(tx: Tx, orgId: string, userId: string) {
  const [o] = await tx.select({ off: organizations.aiDisabledAt }).from(organizations).where(eq(organizations.id, orgId));
  const [u] = await tx.select({ seen: users.aiNoticeSeenAt }).from(users).where(eq(users.id, userId));
  return { aiEnabled: o?.off == null, noticeSeen: u?.seen != null };
}

export const aiSwitchGet = defineAction({
  name: "aiSwitch.get",
  description:
    "Whether AI features are on for the account (an owner can switch them off for everyone), and whether the caller has seen the one-time AI notice. Writes nothing.",
  input: z.object({}),
  output: state,
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }) {
    return read(tx, actor.orgId, actor.userId);
  },
});

export const aiSwitchUpdate = defineAction({
  name: "aiSwitch.update",
  description:
    "Switch AI features on or off for the whole account. While off, no review text or other content is sent to Anthropic or OpenAI and AI actions refuse with a plain message. Web only: not available to API tokens or MCP. Needs billing:manage (owner).",
  input: z.object({ aiEnabled: z.boolean() }).strict(),
  output: state,
  permission: "billing:manage",
  kind: "write",
  async preview({ actor }, input) {
    assertHumanBillingCaller(actor);
    return { summary: input.aiEnabled ? "Turn AI features on for the account." : "Turn AI features off for the account." };
  },
  async handler({ tx, actor, audit }, input) {
    assertHumanBillingCaller(actor);
    const before = await read(tx, actor.orgId, actor.userId);
    if (before.aiEnabled !== input.aiEnabled) {
      await tx
        .update(organizations)
        .set({ aiDisabledAt: input.aiEnabled ? null : new Date() })
        .where(eq(organizations.id, actor.orgId));
    }
    await audit({
      action: "ai.switch_changed",
      entityType: "organization",
      entityId: actor.orgId,
      before: { aiEnabled: before.aiEnabled },
      after: { aiEnabled: input.aiEnabled },
    });
    return { ...before, aiEnabled: input.aiEnabled };
  },
});

export const aiNoticeAcknowledge = defineAction({
  name: "aiNotice.acknowledge",
  description: "Record that the caller has seen the one-time notice about what AI features send to Anthropic. Stored once per person. Writes nothing to Google.",
  input: z.object({}).strict(),
  output: state,
  permission: "location:read",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }) {
    const before = await read(tx, actor.orgId, actor.userId);
    if (!before.noticeSeen) await tx.update(users).set({ aiNoticeSeenAt: new Date() }).where(eq(users.id, actor.userId));
    await audit({
      action: "ai.notice_acknowledged",
      entityType: "user",
      entityId: actor.userId,
      before: { noticeSeen: before.noticeSeen },
      after: { noticeSeen: true },
    });
    return { ...before, noticeSeen: true };
  },
});
