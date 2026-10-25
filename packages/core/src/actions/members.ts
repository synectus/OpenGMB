import { and, asc, eq, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  apiTokens,
  memberships,
  sessions,
  twoFactors,
  users,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import { CoreError } from "../errors";
import { isClientRole } from "../client-role";
import { defineAction } from "../registry";

const memberOut = z.object({
  membershipId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  twoFactorEnabled: z.boolean(),
  role: z.enum(["owner", "admin", "manager", "client_approver", "client_viewer"]),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  createdAt: z.string(),
});

export const membersList = defineAction({
  name: "members.list",
  description:
    "Members of the caller's organization with their role (owner, admin, manager). Organization-wide members have workspaceId null; client members belong to one workspace. Pass workspaceId to get that workspace's clients plus the organization-wide members.",
  input: z.object({ workspaceId: z.uuid().optional() }),
  output: z.object({ members: z.array(memberOut) }),
  permission: "member:invite",
  kind: "read",
  async handler({ tx, actor }, input) {
    const rows = await tx
      .select({
        m: memberships,
        name: users.name,
        email: users.email,
        twoFactorEnabled: users.twoFactorEnabled,
        workspaceName: workspaces.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(
        and(
          eq(memberships.orgId, actor.orgId),
          input.workspaceId
            ? or(isNull(memberships.workspaceId), eq(memberships.workspaceId, input.workspaceId))
            : undefined,
        ),
      )
      .orderBy(asc(users.email), asc(memberships.createdAt));
    return {
      members: rows.map((r) => ({
        membershipId: r.m.id,
        userId: r.m.userId,
        name: r.name,
        email: r.email,
        twoFactorEnabled: r.twoFactorEnabled ?? false,
        role: r.m.role,
        workspaceId: r.m.workspaceId,
        workspaceName: r.workspaceName,
        createdAt: r.m.createdAt.toISOString(),
      })),
    };
  },
});

export const membersRemove = defineAction({
  name: "members.remove",
  description:
    "Remove a membership (owner, admin, manager). An owner can remove anyone; an admin anyone but an owner; a manager only client members. The last owner of an organization cannot be removed (CONFLICT). The person's account stays; they lose access to this organization at once: their sessions end and their API tokens for it are revoked.",
  input: z.object({ membershipId: z.uuid() }),
  output: z.object({ removed: z.boolean() }),
  permission: "member:invite",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [target] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, actor.orgId)))
      .for("update");
    if (!target) throw new AccessError("NOT_FOUND", "Membership not found");
    const clientOnly = actor.role === "manager";
    if (
      (clientOnly && !isClientRole(target.role)) ||
      (actor.role === "admin" && target.role === "owner")
    ) {
      throw new AccessError("FORBIDDEN", `Role ${actor.role} cannot remove a ${target.role}`);
    }
    if (target.role === "owner") {
      // Lock every owner row so two concurrent removals cannot each see "another owner remains".
      const owners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.role, "owner")))
        .for("update");
      if (owners.length <= 1) {
        throw new CoreError("CONFLICT", "The last owner of an organization cannot be removed");
      }
    }
    await tx.delete(memberships).where(eq(memberships.id, target.id));
    await audit({
      action: "membership.remove",
      entityType: "membership",
      entityId: target.id,
      before: target,
      after: null,
    });
    // Access ends now, not at the next sign-in. A person with no membership left in this
    // organization loses their sessions (the server refuses them on the next request) and every
    // API/MCP token they hold here, for good: adding them back later does not revive the token.
    const [stillMember] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, target.userId)))
      .limit(1);
    if (!stillMember) {
      await tx.delete(sessions).where(eq(sessions.userId, target.userId));
      const revoked = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.orgId, actor.orgId),
            eq(apiTokens.userId, target.userId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning({ id: apiTokens.id, name: apiTokens.name });
      for (const t of revoked) {
        await audit({
          action: "api_token.revoke",
          entityType: "api_token",
          entityId: t.id,
          before: { id: t.id, name: t.name, userId: target.userId, revokedAt: null },
          after: { id: t.id, name: t.name, userId: target.userId, reason: "member removed" },
        });
      }
    }
    return { removed: true };
  },
});

/** API tokens never reset anyone's two-factor, not even through a proposal (preview runs first). */
function refuseApiTokenCaller(actor: Pick<Actor, "actorType">) {
  if (actor.actorType === "api_token") {
    throw new AccessError(
      "FORBIDDEN",
      "API tokens cannot reset two-factor authentication; an owner does it on the Team page",
    );
  }
}

/**
 * The member whose two-factor would be reset, checked for everything except the caller's role
 * (that is the permission's job): in the caller's org, not the caller, enrolled, and in no other
 * organization (two-factor is per user, so another org's protection would go with it).
 */
async function resetTarget(tx: Tx, actor: Actor, membershipId: string) {
  const [row] = await tx
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      email: users.email,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, actor.orgId)));
  if (!row) throw new AccessError("NOT_FOUND", "Membership not found");
  if (row.userId === actor.userId) {
    throw new AccessError(
      "FORBIDDEN",
      "You cannot reset your own two-factor authentication here; use Reset authenticator app on your Account page",
    );
  }
  const [elsewhere] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, row.userId), ne(memberships.orgId, actor.orgId)))
    .limit(1);
  if (elsewhere) {
    throw new CoreError(
      "CONFLICT",
      "This person also belongs to another organization, so their two-factor authentication cannot be reset from here",
    );
  }
  if (!row.twoFactorEnabled) {
    throw new CoreError("CONFLICT", "This member has not set up two-factor authentication yet");
  }
  return row;
}

export const membersResetTwoFactor = defineAction({
  name: "members.resetTwoFactor",
  description:
    "Reset a member's two-factor authentication (owner only; never your own; not available to API tokens). Deletes their authenticator secret and backup codes and signs them out everywhere. Until they set up a new authenticator app at their next sign-in, their password (or Google) alone signs them in, and they cannot use OpenGMB until they do. CONFLICT when the member has not set up two-factor or also belongs to another organization.",
  input: z.object({ membershipId: z.uuid() }),
  output: z.object({ reset: z.literal(true), sessionsEnded: z.number().int().nonnegative() }),
  permission: "member:reset_two_factor",
  kind: "write",
  async preview({ actor, readTx }, input) {
    refuseApiTokenCaller(actor);
    const t = await readTx((tx) => resetTarget(tx, actor, input.membershipId));
    return {
      summary: `Reset two-factor authentication for ${t.email}: delete their authenticator and backup codes and sign them out everywhere.`,
    };
  },
  async handler({ tx, actor, audit }, input) {
    refuseApiTokenCaller(actor);
    const t = await resetTarget(tx, actor, input.membershipId);
    // Serialise concurrent resets of the same person.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, t.userId)).for("update");
    const ended = await tx
      .delete(sessions)
      .where(eq(sessions.userId, t.userId))
      .returning({ id: sessions.id });
    await tx.delete(twoFactors).where(eq(twoFactors.userId, t.userId));
    await tx
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, t.userId));
    // Never the two_factors row: it holds the secret and the backup codes.
    await audit({
      action: "membership.two_factor_reset",
      entityType: "membership",
      entityId: t.membershipId,
      before: { userId: t.userId, email: t.email, twoFactorEnabled: true, sessions: ended.length },
      after: { userId: t.userId, twoFactorEnabled: false, sessionsEnded: ended.length },
    });
    return { reset: true as const, sessionsEnded: ended.length };
  },
});
