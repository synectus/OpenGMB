import { and, eq } from "drizzle-orm";
import { memberships, organizations, type Db } from "@opengmb/db";
import { BLOCKED_MESSAGES, isOrgBlocked } from "./account-state";
import { CoreError } from "./errors";
import { roleHasPermission, type Permission, type Role } from "./permissions";
import type { AnyAction } from "./registry";

export class AccessError extends CoreError {
  constructor(code: "FORBIDDEN" | "NOT_FOUND" = "FORBIDDEN", message?: string) {
    super(code, message);
    this.name = "AccessError";
  }
}

/** The user belongs to several organisations and the caller did not say which. */
export class OrgSelectionRequiredError extends CoreError {
  constructor(public readonly orgIds: string[]) {
    super("INVALID_INPUT", "User belongs to several organizations; orgId is required");
    this.name = "OrgSelectionRequiredError";
  }
}

/** What a read-only (view-as) actor is told when it tries to change something. */
export const READ_ONLY_VIEW_MESSAGE = "Read-only view: changes are turned off.";

/** Refused for a read-only actor with this error (code FORBIDDEN, `view` READ_ONLY_VIEW). */
export class ReadOnlyViewError extends AccessError {
  readonly view = "READ_ONLY_VIEW";
  constructor() {
    super("FORBIDDEN", READ_ONLY_VIEW_MESSAGE);
    this.name = "ReadOnlyViewError";
  }
}

/**
 * Read actions a read-only actor is still refused, because running them changes something or spends money:
 * - posts.syncGoogle stores Google's posts in our copy of the location (a write dressed as a read);
 * - integrations.testDataForSeo calls the paid provider with the platform's own login.
 * Every other read action that reaches a paid provider (DataForSEO, an AI model) was checked by hand on 2026-10-25 and
 * does not call it from a read (geogrid.preview and aiVisibility.get only estimate; aiUsage.get, reviewTopics.status and
 * postImages.sources only check configuration). Not listed here: the Google calls reads make, which are free.
 */
export const READ_ONLY_REFUSED_READS: ReadonlySet<string> = new Set(["posts.syncGoogle", "integrations.testDataForSeo"]);

export const TOKEN_SCOPES = ["read", "write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** human_in_the_loop: the token drafts, a person approves in the app. full_autonomy: acts with its owner's rights. */
export const TOKEN_MODES = ["human_in_the_loop", "full_autonomy"] as const;
export type TokenMode = (typeof TOKEN_MODES)[number];
export const DEFAULT_TOKEN_MODE: TokenMode = "human_in_the_loop";

/** Actions a human_in_the_loop token is refused, beyond every review:approve / review:publish action. */
const HUMAN_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "profile.apply",
  "profile.changes.accept",
  "mcp.proposals.apply",
]);

export type Actor = {
  userId: string;
  orgId: string;
  /** Org-wide role, or the client role when the user only has client memberships. */
  role: Role;
  workspaceIds: string[] | "all";
  /** "mcp" is the API token surface: the MCP endpoint and REST v1 (/v1/actions) both audit as "mcp". */
  surface: "ui" | "mcp" | "worker";
  actorType: "user" | "api_token" | "system";
  apiTokenId?: string;
  /**
   * API-token actors only: what the token may do. A token without `write` is read-only. Set by
   * verifyApiToken (the only production source of api_token actors); absent means not token-limited.
   */
  scopes?: readonly TokenScope[];
  /** API-token actors only. Absent means human_in_the_loop (the safe reading). */
  tokenMode?: TokenMode;
  /**
   * A support view of someone else's organization: the actor may read what the owner reads and nothing else.
   * authorizeAction refuses every write action for it and the executor opens its transactions READ ONLY.
   * Only the web actor helper sets it, from a view-as grant; nothing sets it in the community edition.
   */
  readOnly?: true;
};

/** The owner's view of `orgId` for `userId`, marked read-only. For a view-as grant; the caller has checked the grant. */
export function viewAsActor(input: { userId: string; orgId: string }): Actor {
  return {
    userId: input.userId,
    orgId: input.orgId,
    role: "owner",
    workspaceIds: "all",
    surface: "ui",
    actorType: "user",
    readOnly: true,
  };
}

export type LoadActorInput = {
  userId: string;
  orgId?: string;
  surface: Actor["surface"];
  actorType: Actor["actorType"];
  apiTokenId?: string;
  scopes?: readonly TokenScope[];
};

export async function loadActor(db: Db, input: LoadActorInput): Promise<Actor> {
  const rows = await db
    .select({
      orgId: memberships.orgId,
      workspaceId: memberships.workspaceId,
      role: memberships.role,
    })
    .from(memberships)
    .where(
      input.orgId
        ? and(eq(memberships.userId, input.userId), eq(memberships.orgId, input.orgId))
        : eq(memberships.userId, input.userId),
    );
  if (rows.length === 0) throw new AccessError("FORBIDDEN", "No membership");

  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  if (orgIds.length > 1) throw new OrgSelectionRequiredError(orgIds);
  const orgId = orgIds[0]!;
  // AP3b: the org-level backstop for everything that loads an actor (web actions and pages, API routes, tokens). The
  // worker is excluded: its jobs are guarded where they start, so a job never fails half way for a suspended org.
  if (input.surface !== "worker" && (await isOrgBlocked(db, orgId))) {
    throw new AccessError("FORBIDDEN", BLOCKED_MESSAGES.org_suspended);
  }

  const orgWide = rows.find((r) => r.workspaceId === null);
  const base = {
    userId: input.userId,
    orgId,
    surface: input.surface,
    actorType: input.actorType,
    ...(input.apiTokenId ? { apiTokenId: input.apiTokenId } : {}),
    ...(input.scopes ? { scopes: input.scopes } : {}),
  };
  if (orgWide) return { ...base, role: orgWide.role, workspaceIds: "all" };

  // Client memberships only. The Actor carries one role, but client roles are per workspace and
  // only client_approver holds review:approve. A mix would otherwise let an approver in A approve
  // in B where they are a viewer, so a mix collapses to the least privileged role (invitations
  // also refuse to create a mix; this is the backstop for rows created any other way).
  const roles = new Set(rows.map((r) => r.role));
  const role: Role = roles.has("client_viewer") ? "client_viewer" : "client_approver";
  return { ...base, role, workspaceIds: rows.map((r) => r.workspaceId!) };
}

export function authorize(
  actor: Actor,
  permission: Permission,
  scope: { workspaceId?: string } = {},
): void {
  if (!roleHasPermission(actor.role, permission)) {
    throw new AccessError("FORBIDDEN", `Role ${actor.role} lacks ${permission}`);
  }
  if (
    scope.workspaceId !== undefined &&
    actor.workspaceIds !== "all" &&
    !actor.workspaceIds.includes(scope.workspaceId)
  ) {
    throw new AccessError("FORBIDDEN", "Workspace outside actor scope");
  }
}

/**
 * Role permission AND token scope, for running one action. The scope rules:
 * - a token without the `write` scope (read-only) may run no write action;
 * - a client_approver token with `write` may run only review:approve actions (approve / reject).
 * Read actions are never limited by scope. Callers without `scopes` (web sessions) are unaffected.
 */
export function authorizeAction(
  actor: Actor,
  action: Pick<AnyAction, "name" | "permission" | "kind">,
): void {
  if (actor.readOnly && (action.kind === "write" || READ_ONLY_REFUSED_READS.has(action.name))) {
    throw new ReadOnlyViewError();
  }
  authorize(actor, action.permission);
  if (action.kind !== "write" || !actor.scopes) return;
  if (!actor.scopes.includes("write")) {
    throw new AccessError(
      "FORBIDDEN",
      `This API token is read-only and cannot run ${action.name}; create a token with read and write scope`,
    );
  }
  if (actor.role === "client_approver" && action.permission !== "review:approve") {
    throw new AccessError(
      "FORBIDDEN",
      `A client_approver token may only approve or reject, not run ${action.name}`,
    );
  }
  if (
    actor.actorType === "api_token" &&
    actor.tokenMode !== "full_autonomy" &&
    (action.permission === "review:approve" ||
      action.permission === "review:publish" ||
      HUMAN_ONLY_ACTIONS.has(action.name))
  ) {
    throw new AccessError(
      "FORBIDDEN",
      `This API token is in human-in-the-loop mode and cannot run ${action.name}: A person must approve this in OpenGMB. Leave the work pending for them, or ask the token's owner to create a full-autonomy token.`,
    );
  }
}

/** For list queries: 'all' (no workspace filter) or the exact workspace ids to filter on. */
export function workspaceScope(actor: Actor): string[] | "all" {
  return actor.workspaceIds;
}

export type ActorContext = {
  organization: { id: string; name: string };
  role: Role;
  /** Which home the UI shows. Core decides; UI code never inspects roles. */
  home: "app" | "portal";
};

/** What the UI shows about the current actor; keeps role lookup out of UI code. */
export async function getActorContext(db: Db, actor: Actor): Promise<ActorContext> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId));
  if (!org) throw new AccessError("NOT_FOUND", "Organization not found");
  return {
    organization: org,
    role: actor.role,
    home: actor.role === "client_approver" || actor.role === "client_viewer" ? "portal" : "app",
  };
}
