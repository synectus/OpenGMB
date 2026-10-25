import { createHash } from "node:crypto";
import { and, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { apiTokens, mcpProposals, type Db } from "@opengmb/db";
import { AccessError, authorizeAction, type Actor } from "./actor";
import { effectiveScopes } from "./apiTokens";
import { isExternalEffect, personMustApproveMessage } from "./external-effects";
import { canonicalJson, writeAudit } from "./audit";
import { MCP_CONFIG } from "./config/mcp";
import { CoreError } from "./errors";
import { InvalidInputError, executeAction, runParsed } from "./executor";
import { GoogleWritesDisabledError } from "./google/errors";
import type { GuardrailResult } from "./guardrails/types";
import { actions } from "./actions";
import type { ActionContext, ActionPreview, AnyAction, PreviewContext } from "./registry";

/** What an MCP client sees before anything is written. `findings` is always present. */
export type ProposalPreview = {
  summary: string;
  diff: unknown;
  findings: GuardrailResult;
};

const NO_FINDINGS: GuardrailResult = Object.freeze({ ok: true, violations: [], packs: [] });

export const hashInput = (input: unknown) =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");

/** A top-level string field that can carry a bearer secret (share link, OAuth URL) is not stored. */
const SECRET_KEY = /url|token|secret|password/i;
export function redactResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result ?? null;
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [
      k,
      typeof v === "string" && SECRET_KEY.test(k) ? "[redacted]" : v,
    ]),
  );
}

function previewContext(db: Db, actor: Actor, registry: readonly AnyAction[]): PreviewContext {
  return {
    actor,
    async read(name, input) {
      const target = registry.find((a) => a.name === name);
      if (!target || target.kind !== "read") {
        throw new Error(`preview may only read: ${name} is not a read action`);
      }
      return executeAction(db, actor, name, input, registry);
    },
    readTx: (fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return fn(tx);
      }),
  };
}

function normalise(p: ActionPreview): ProposalPreview {
  return { summary: p.summary, diff: p.diff ?? null, findings: p.findings ?? NO_FINDINGS };
}

/** Run the action's own `preview`, or the generic one. Never writes. */
export async function runPreview(
  db: Db,
  actor: Actor,
  action: AnyAction,
  input: unknown,
  registry: readonly AnyAction[] = actions,
): Promise<ProposalPreview> {
  if (!action.preview) {
    return normalise({
      summary: `Would run ${action.name}. This action has no detailed preview; the input below is exactly what will be applied.`,
      diff: { input },
    });
  }
  return normalise(await action.preview(previewContext(db, actor, registry), input));
}

const blockIds = (f: GuardrailResult) =>
  f.violations.filter((v) => v.severity === "block").map((v) => v.ruleId);

/** Phase 1: preview, then store the proposal and audit it. Writes nothing else. */
export async function createProposal(
  db: Db,
  actor: Actor,
  action: AnyAction,
  input: unknown,
  registry: readonly AnyAction[] = actions,
) {
  if (!actor.apiTokenId) {
    throw new AccessError("FORBIDDEN", "Proposals are bound to an API token");
  }
  const tokenId = actor.apiTokenId;
  const preview = await runPreview(db, actor, action, input, registry);
  const expiresAt = new Date(Date.now() + MCP_CONFIG.proposalTtlMs);
  const inputHash = hashInput(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mcpProposals)
      .values({
        orgId: actor.orgId,
        tokenId,
        userId: actor.userId,
        action: action.name,
        input: input as object,
        inputHash,
        preview,
        expiresAt,
      })
      .returning();
    await writeAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      actorType: actor.actorType,
      surface: actor.surface,
      action: "mcp.proposal_created",
      entityType: "mcp_proposal",
      entityId: row!.id,
      before: null,
      after: { action: action.name, inputHash, expiresAt: expiresAt.toISOString(), tokenId },
    });
    return { proposalId: row!.id, expiresAt: expiresAt.toISOString(), preview };
  });
}

type ProposalRow = typeof mcpProposals.$inferSelect;

type Owned = {
  p: ProposalRow;
  /** The caller is the token owner's own web session, not the proposing token. */
  viaWeb: boolean;
  tokenRevoked: boolean;
  tokenScopes: string[];
};

/**
 * The proposal, if this actor may act on it (rule decided in plan 5A):
 * - always the same organisation and the same user, who owns the proposing API token;
 * - over MCP, also the same API token;
 * - without a token, only that person's web session (surface "ui", actor type "user"), never a
 *   worker, CLI or system actor.
 */
async function loadOwn(db: Db, actor: Actor, id: string): Promise<Owned> {
  const [row] = await db
    .select({ p: mcpProposals, revokedAt: apiTokens.revokedAt, scopes: apiTokens.scopes })
    .from(mcpProposals)
    .innerJoin(apiTokens, eq(apiTokens.id, mcpProposals.tokenId))
    .where(eq(mcpProposals.id, id));
  // Another organisation's proposal looks exactly like a missing one.
  if (!row || row.p.orgId !== actor.orgId) throw new AccessError("NOT_FOUND", "Proposal not found");
  const viaToken = actor.apiTokenId !== undefined;
  const viaWeb = !viaToken && actor.surface === "ui" && actor.actorType === "user";
  if (
    row.p.userId !== actor.userId ||
    (viaToken && row.p.tokenId !== actor.apiTokenId) ||
    (!viaToken && !viaWeb)
  ) {
    throw new AccessError("FORBIDDEN", "Proposal belongs to another API token or user");
  }
  return { p: row.p, viaWeb, tokenRevoked: row.revokedAt !== null, tokenScopes: row.scopes };
}

const effectiveStatus = (p: ProposalRow, now = new Date()) =>
  p.status === "pending" && p.expiresAt <= now ? "expired" : p.status;

/** `CODE: message` as stored on a failed proposal. A refused Google write gets its own code. */
function failureText(e: unknown): string {
  const code =
    e instanceof GoogleWritesDisabledError
      ? "google_writes_disabled"
      : e instanceof CoreError
        ? e.code
        : "INTERNAL";
  return `${code}: ${e instanceof Error ? e.message : "failed"}`.slice(0, 500);
}

/** Phase 2: re-validate everything, then run the stored input once through the normal executor path. */
export async function applyProposal(ctx: ActionContext, id: string) {
  const { tx, db, actor, audit } = ctx;
  const { p, viaWeb, tokenRevoked, tokenScopes } = await loadOwn(db, actor, id);
  const status = effectiveStatus(p);
  if (status === "expired" && p.status === "pending") {
    await db
      .update(mcpProposals)
      .set({ status: "expired" })
      .where(and(eq(mcpProposals.id, p.id), eq(mcpProposals.status, "pending")));
  }
  if (status !== "pending") {
    throw new CoreError(
      "CONFLICT",
      status === "expired"
        ? "Proposal expired; call the tool again to get a new one"
        : `Proposal is already ${status}`,
    );
  }
  if (viaWeb && tokenRevoked) {
    throw new AccessError(
      "FORBIDDEN",
      "The API token that made this proposal was revoked; ask your agent to propose it again",
    );
  }
  // From the web the person's current role applies AND the proposing token's scope limits.
  const runAs: Actor = viaWeb ? { ...actor, scopes: effectiveScopes(actor.role, tokenScopes) } : actor;

  const action = actions.find((a) => a.name === p.action);
  if (!action) throw new CoreError("NOT_FOUND", `Unknown action ${p.action}`);
  // Q33d: a proposal that changes something outside OpenGMB is applied by a signed-in person, never
  // by a token. The proposal stays pending (this is not a failure of the proposal).
  if (!viaWeb && isExternalEffect(p.action)) {
    throw new AccessError("FORBIDDEN", personMustApproveMessage("proposal", p.action));
  }
  // The actor was loaded fresh for this request, so a role downgrade or a revoked scope shows here.
  authorizeAction(runAs, action);
  if (hashInput(p.input) !== p.inputHash) {
    throw new CoreError("CONFLICT", "Stored proposal input no longer matches its hash");
  }
  const parsed = action.input.safeParse(p.input);
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues);

  const preview = await runPreview(db, runAs, action, parsed.data);
  const blocked = blockIds(preview.findings);
  if (blocked.length > 0) {
    throw new CoreError("CONFLICT", `Blocked by policy: ${blocked.join(", ")}`);
  }

  let result: unknown;
  try {
    // A savepoint inside the apply transaction: the action's writes and audit rows commit with
    // the proposal row, or not at all.
    result = await tx.transaction((sp) => runParsed(db, runAs, action, parsed.data, sp));
  } catch (e) {
    // Separate connection: this survives the rollback of the apply transaction.
    await db
      .update(mcpProposals)
      .set({ status: "failed", error: failureText(e) })
      .where(and(eq(mcpProposals.id, p.id), eq(mcpProposals.status, "pending")));
    throw e;
  }

  const [claimed] = await tx
    .update(mcpProposals)
    .set({ status: "applied", appliedAt: new Date(), result: redactResult(result) as object })
    .where(and(eq(mcpProposals.id, p.id), eq(mcpProposals.status, "pending")))
    .returning({ id: mcpProposals.id });
  // A concurrent apply won: throwing rolls back this run's writes too.
  if (!claimed) throw new CoreError("CONFLICT", "Proposal is already applied");
  await audit({
    action: "mcp.proposal_applied",
    entityType: "mcp_proposal",
    entityId: p.id,
    before: { status: "pending" },
    after: {
      status: "applied",
      action: p.action,
      inputHash: p.inputHash,
      tokenId: p.tokenId,
      via: viaWeb ? "web" : "token",
    },
  });
  return { proposalId: p.id, status: "applied" as const, action: p.action, result };
}

export async function cancelProposal(ctx: ActionContext, id: string) {
  const { tx, db, actor, audit } = ctx;
  const { p, viaWeb } = await loadOwn(db, actor, id);
  const status = effectiveStatus(p);
  if (status !== "pending") throw new CoreError("CONFLICT", `Proposal is already ${status}`);
  const [row] = await tx
    .update(mcpProposals)
    .set({ status: "cancelled" })
    .where(and(eq(mcpProposals.id, p.id), eq(mcpProposals.status, "pending")))
    .returning({ id: mcpProposals.id });
  if (!row) throw new CoreError("CONFLICT", "Proposal is no longer pending");
  await audit({
    action: "mcp.proposal_cancelled",
    entityType: "mcp_proposal",
    entityId: p.id,
    before: { status: "pending" },
    after: { status: "cancelled", action: p.action, via: viaWeb ? "web" : "token" },
  });
  return { proposalId: p.id, status: "cancelled" as const };
}

/** SQL for a status as the caller sees it: "expired" includes pending rows past their expiry. */
function statusWhere(status: ProposalRow["status"] | undefined, now: Date) {
  if (!status) return undefined;
  if (status === "pending") {
    return and(eq(mcpProposals.status, "pending"), gt(mcpProposals.expiresAt, now));
  }
  if (status === "expired") {
    return or(
      eq(mcpProposals.status, "expired"),
      and(eq(mcpProposals.status, "pending"), lte(mcpProposals.expiresAt, now)),
    );
  }
  return eq(mcpProposals.status, status);
}

/**
 * The caller's own proposals, newest first: this token's over MCP, every one of the person's
 * tokens from the web. The status filter runs in SQL before the limit.
 */
export async function listProposals(
  ctx: ActionContext,
  opts: { status?: ProposalRow["status"]; limit: number },
) {
  const { tx, actor } = ctx;
  const now = new Date();
  const rows = await tx
    .select({ p: mcpProposals, tokenName: apiTokens.name, tokenRevokedAt: apiTokens.revokedAt })
    .from(mcpProposals)
    .innerJoin(apiTokens, eq(apiTokens.id, mcpProposals.tokenId))
    .where(
      and(
        eq(mcpProposals.orgId, actor.orgId),
        eq(mcpProposals.userId, actor.userId),
        actor.apiTokenId ? eq(mcpProposals.tokenId, actor.apiTokenId) : undefined,
        statusWhere(opts.status, now),
      ),
    )
    .orderBy(desc(mcpProposals.createdAt), desc(mcpProposals.id))
    .limit(opts.limit);
  return rows.map(({ p, tokenName, tokenRevokedAt }) => ({
    proposalId: p.id,
    action: p.action,
    status: effectiveStatus(p, now),
    expiresAt: p.expiresAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    appliedAt: p.appliedAt?.toISOString() ?? null,
    error: p.error,
    preview: p.preview,
    tokenId: p.tokenId,
    tokenName,
    tokenRevoked: tokenRevokedAt !== null,
  }));
}
