import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiTokens, organizations, users } from "@opengmb/db";
import {
  assertNotApiTokenCaller,
  createApiTokenFor,
  listApiTokens,
  revokeApiTokenFor,
} from "../apiTokens";
import { AccessError, TOKEN_MODES, TOKEN_SCOPES } from "../actor";
import { defineAction } from "../registry";

const tokenOut = z.object({
  id: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  ownerEmail: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  mode: z.enum(TOKEN_MODES),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const apiTokensList = defineAction({
  name: "apiTokens.list",
  description:
    "List API tokens in the caller's organization, newest first, including revoked ones. Members see their own tokens; owners and admins see everyone's. Never returns token secrets.",
  input: z.object({}),
  output: z.object({ tokens: z.array(tokenOut) }),
  permission: "api_token:manage_own",
  kind: "read",
  async handler({ tx, actor }) {
    return { tokens: await listApiTokens(tx, actor) };
  },
});

export const apiTokensCreate = defineAction({
  name: "apiTokens.create",
  description:
    'Create an API token for the caller. The plaintext token is returned once and cannot be recovered. scopes: ["read"] makes a read-only token (cannot run any write tool; resources stay readable), ["read","write"] (the default) a read and write token; client_viewer tokens are always read-only. mode: "human_in_the_loop" (the default) makes a token that cannot approve, publish or apply proposals (a person does that in the app); "full_autonomy" lets it also apply changes that stay inside OpenGMB with the owner rights. In both modes anything that changes Google or reaches outside OpenGMB (replies, posts, profile edits, photos, review request sends, payments, public links) needs a person to approve it in the app. The mode is fixed at creation. Not available to callers authenticated by an API token.',
  input: z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
    mode: z.enum(TOKEN_MODES).optional(),
  }),
  output: z.object({ token: z.string(), apiToken: tokenOut }),
  permission: "api_token:manage_own",
  kind: "write",
  async preview({ actor }, input) {
    assertNotApiTokenCaller(actor);
    return {
      summary: `Would create a ${input.scopes?.includes("write") !== false ? "read and write" : "read-only"} API token named "${input.name}" (the secret is shown once, on apply).`,
      diff: {
        before: null,
        after: {
          name: input.name,
          scopes: input.scopes ?? ["read", "write"],
          mode: input.mode ?? "human_in_the_loop",
        },
      },
    };
  },
  async handler({ tx, actor, audit }, input) {
    return createApiTokenFor(tx, actor, input.name, audit, input.scopes, input.mode);
  },
});

export const apiTokensRevoke = defineAction({
  name: "apiTokens.revoke",
  description:
    "Revoke an API token by id. Members may revoke their own tokens; owners and admins may revoke any token in the organization.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ apiToken: tokenOut }),
  permission: "api_token:manage_own",
  kind: "write",
  // Direct, not two_phase: revoking only removes access, and incident response must not wait for a
  // second call. dryRun still previews it.
  approval: "own_flow",
  async preview({ actor, readTx }, input) {
    const [row] = await readTx((tx) =>
      tx
        .select({ name: apiTokens.name, userId: apiTokens.userId, revokedAt: apiTokens.revokedAt })
        .from(apiTokens)
        .where(and(eq(apiTokens.id, input.id), eq(apiTokens.orgId, actor.orgId))),
    );
    if (!row) throw new AccessError("NOT_FOUND", "API token not found");
    return {
      summary: row.revokedAt
        ? `API token "${row.name}" is already revoked; revoking would fail with CONFLICT.`
        : `Would revoke API token "${row.name}". Clients using it get 401 immediately.`,
      diff: { before: { revoked: row.revokedAt !== null }, after: { revoked: true } },
    };
  },
  async handler({ tx, actor, audit }, input) {
    return revokeApiTokenFor(tx, actor, input.id, audit);
  },
});

export const apiTokensCurrent = defineAction({
  name: "apiTokens.current",
  description:
    "Who is calling: the caller's organization, user email and role, plus the API token's id, name and scopes (token is null for a web session). Use it to test a connection.",
  input: z.object({}),
  output: z.object({
    organization: z.object({ id: z.string(), name: z.string() }),
    user: z.object({ email: z.string() }),
    role: z.string(),
    token: z
      .object({
        id: z.string(),
        name: z.string(),
        scopes: z.array(z.enum(TOKEN_SCOPES)),
        mode: z.enum(TOKEN_MODES),
      })
      .nullable(),
  }),
  permission: "api_token:manage_own",
  kind: "read",
  async handler({ tx, actor }) {
    const [org] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (!org || !user) throw new AccessError("NOT_FOUND", "Caller not found");
    let token: {
      id: string;
      name: string;
      scopes: ("read" | "write")[];
      mode: (typeof TOKEN_MODES)[number];
    } | null = null;
    if (actor.apiTokenId) {
      const [t] = await tx
        .select({ id: apiTokens.id, name: apiTokens.name, mode: apiTokens.mode })
        .from(apiTokens)
        .where(and(eq(apiTokens.id, actor.apiTokenId), eq(apiTokens.orgId, actor.orgId)));
      if (t) {
        token = {
          ...t,
          mode: t.mode as (typeof TOKEN_MODES)[number],
          scopes: [...(actor.scopes ?? ["read", "write"])],
        };
      }
    }
    return { organization: org, user, role: actor.role, token };
  },
});
