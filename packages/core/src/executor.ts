import type { z } from "zod";
import type { Db, Tx } from "@opengmb/db";
import type { Actor } from "./actor";
import { AccessError, authorizeAction } from "./actor";
import { isExternalEffect, personMustApproveMessage } from "./external-effects";
import { writeAudit } from "./audit";
import { CoreError } from "./errors";
import { approvalOf, type AnyAction } from "./registry";
import { createProposal, runPreview } from "./proposals";
import { actions } from "./actions";
import { assertWritable } from "./billing";

/** INVALID_INPUT carrying the zod issues, so surfaces can show which field was wrong. */
export class InvalidInputError extends CoreError {
  constructor(public readonly issues: z.core.$ZodIssue[]) {
    super(
      "INVALID_INPUT",
      issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; "),
    );
    this.name = "InvalidInputError";
  }
}

/**
 * Run one action as `actor`. Order: lookup, permission and token scope, input parse, handler inside
 * a transaction, audit assertion (write actions), output parse. Anything thrown rolls back.
 * `registry` exists so tests can run an action that is not in the production registry.
 * This always executes: the MCP surface goes through `executeToolCall`, which adds the
 * propose / dry-run gate in front of it.
 */
export async function executeAction(
  db: Db,
  actor: Actor,
  name: string,
  rawInput: unknown,
  registry: readonly AnyAction[] = actions,
): Promise<unknown> {
  const action = registry.find((a) => a.name === name);
  if (!action) throw new CoreError("NOT_FOUND", `Unknown action ${name}`);

  authorizeAction(actor, action);

  const parsed = action.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues);
  return runParsed(db, actor, action, parsed.data);
}

/**
 * Run an already authorized and parsed action. With `within` the handler joins that transaction
 * (proposal apply runs it inside a savepoint of its own transaction) instead of opening one.
 */
export async function runParsed(
  db: Db,
  actor: Actor,
  action: AnyAction,
  input: unknown,
  within?: Tx,
): Promise<unknown> {
  const name = action.name;
  if (action.outsideTransaction) {
    if (action.kind !== "read")
      throw new Error(`Action ${name}: outsideTransaction needs kind read`);
    const noTx = () => {
      throw new Error(`Action ${name} runs outside a transaction: use ctx.db`);
    };
    const result = await action.handler(
      {
        get tx(): never {
          return noTx();
        },
        db,
        actor,
        audit: async () => noTx(),
        afterCommit: () => noTx(),
      },
      input,
    );
    return action.output.parse(result);
  }

  const after: (() => void)[] = [];
  const body = async (tx: Tx) => {
    // Read-only accounts (an ended trial, a lapsed plan) refuse writes here and nowhere else.
    if (action.kind === "write") await assertWritable(tx, actor, name, new Date());
    let auditRows = 0;
    const result = await action.handler(
      {
        tx,
        db,
        actor,
        audit: async (entry) => {
          await writeAudit(tx, {
            ...entry,
            orgId: actor.orgId,
            actorUserId: actor.userId,
            actorType: actor.actorType,
            surface: actor.surface,
          });
          auditRows++;
        },
        afterCommit: (fn) => void after.push(fn),
      },
      input,
    );
    if (action.kind === "write" && auditRows === 0) {
      throw new Error(`Write action ${name} wrote no audit row; rolled back`);
    }
    return action.output.parse(result);
  };
  const out = await (within ? body(within) : db.transaction(body));
  for (const fn of after) fn();
  return out;
}

/**
 * The MCP entry point: `propose -> check -> approve -> publish` for every write tool, in one place.
 * Reads execute. For a write:
 * - the token and role are checked first (a read-only token is FORBIDDEN even for dryRun);
 * - `two_phase` actions (default) never execute here: the call stores a proposal and returns
 *   { proposalId, expiresAt, preview }; `mcp.proposals.apply` executes it once;
 * - `own_flow` actions already are an approval state machine, so they execute directly, and
 *   `dryRun: true` returns { dryRun: true, preview } without side effects.
 * `dryRun` is a transport flag, not an action input; it is stripped before the input is parsed.
 */
export async function executeToolCall(
  db: Db,
  actor: Actor,
  name: string,
  rawInput: unknown,
  registry: readonly AnyAction[] = actions,
): Promise<unknown> {
  const action = registry.find((a) => a.name === name);
  if (!action) throw new CoreError("NOT_FOUND", `Unknown action ${name}`);
  if (action.kind === "read") return executeAction(db, actor, name, rawInput, registry);

  authorizeAction(actor, action);
  const { dryRun = false, ...rest } = (rawInput ?? {}) as Record<string, unknown>;
  const mode = approvalOf(action);
  if (mode === "own_flow" && dryRun !== true) {
    // Q33d: an own_flow action that changes something outside OpenGMB (publish, approve, apply) is
    // run by a signed-in person, whatever the token mode.
    if (isExternalEffect(name)) {
      throw new AccessError("FORBIDDEN", personMustApproveMessage("approval", name));
    }
    return executeAction(db, actor, name, rest, registry);
  }
  const parsed = action.input.safeParse(rest);
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues);
  if (mode === "own_flow") {
    return { dryRun: true, preview: await runPreview(db, actor, action, parsed.data, registry) };
  }
  return createProposal(db, actor, action, parsed.data, registry);
}
