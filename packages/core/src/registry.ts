import type { z } from "zod";
import type { Db, Tx } from "@opengmb/db";
import type { Actor } from "./actor";
import type { AuditEntry } from "./audit";
import type { GuardrailResult } from "./guardrails/types";
import type { Permission } from "./permissions";

/** What an action supplies for an audit row; org, actor and surface come from the actor. */
export type ActionAuditEntry = Pick<
  AuditEntry,
  "action" | "entityType" | "entityId" | "before" | "after"
>;

export type ActionContext = {
  /** The action's transaction. For `outsideTransaction` actions this throws: use `db`. */
  tx: Tx;
  /** Plain connection, for read actions that call Google and so must not hold a transaction open. */
  db: Db;
  actor: Actor;
  /** The only way an action writes audit rows; the executor counts these for `write` actions. */
  audit(entry: ActionAuditEntry): Promise<void>;
  /**
   * Run `fn` once the action's transaction has committed; dropped if it rolls back. For in-process
   * state that must follow the database (a cache). When the handler joined a caller's transaction
   * (`within`) it runs when the handler finishes, because that commit is not ours to see.
   */
  afterCommit(fn: () => void): void;
};

/** What a write action tells an MCP client before anything is written. */
export type ActionPreview = {
  summary: string;
  /** Free-form before/after description of what would change. */
  diff?: unknown;
  /** Guardrail or policy findings, GuardrailResult-shaped. A `block` finding stops an apply. */
  findings?: GuardrailResult;
};

/** Read-only toolbox handed to `preview`: it has no way to write. */
export type PreviewContext = {
  actor: Actor;
  /** Run a READ action as the same actor (permission and scope checks included). */
  read(name: string, input: unknown): Promise<unknown>;
  /** Run a query in a READ ONLY transaction: Postgres rejects any write. */
  readTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/**
 * How a write action is gated over MCP (the web UI always executes directly):
 * - two_phase (default): the MCP call stores a proposal and returns a preview; `mcp_proposals_apply` runs it.
 * - own_flow: the action already is a human-approval state machine (draft, submit, approve, publish ...),
 *   so MCP calls execute directly and the action's own flow is the gate. `dryRun: true` returns `preview`.
 */
export type ApprovalMode = "two_phase" | "own_flow";

export type Action<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  input: I;
  output: O;
  permission: Permission;
  kind: "read" | "write";
  /**
   * Read actions only: run the handler with no transaction (ctx.tx throws, ctx.audit throws). For
   * handlers that call Google, which can sleep for the throttler or back off for a long time.
   */
  outsideTransaction?: boolean;
  /** Write actions only. Defaults to two_phase. */
  approval?: ApprovalMode;
  /**
   * Write actions only: describe what the call would do. Pure read, never writes (PreviewContext has
   * no write path). Without it MCP clients get a generic preview that echoes the input.
   */
  preview?(ctx: PreviewContext, input: z.output<I>): Promise<ActionPreview>;
  handler(ctx: ActionContext, input: z.output<I>): Promise<z.input<O>>;
};

/** Identity helper that gives the handler its input/output types from the zod schemas. */
export function defineAction<I extends z.ZodObject, O extends z.ZodObject>(
  action: Action<I, O>,
): Action<I, O> {
  return action;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry holds actions of differing schemas
export type AnyAction = Action<any, any>;

/** MCP tool / web server-action name for an action. Anthropic tool names disallow dots. */
export function toolNameFor(actionName: string): string {
  return actionName.replaceAll(".", "_");
}

export function approvalOf(action: Pick<AnyAction, "kind" | "approval">): ApprovalMode | null {
  return action.kind === "write" ? (action.approval ?? "two_phase") : null;
}
