import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CoreError,
  approvalOf,
  executeToolCall,
  isExternalEffect,
  toolNameFor,
  type Actor,
  type AnyAction,
  recordError,
  toErrorInfo,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";
import { registerResources } from "./resources";

export { toolNameFor };

const asText = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value) });

const dryRun = z
  .boolean()
  .optional()
  .describe(
    "Preview only: nothing is changed. Two-phase tools always return a proposal (apply it with mcp_proposals_apply); tools with their own approval flow return a preview of the call.",
  );

const WRITE_NOTE: Record<"two_phase" | "own_flow", string> = {
  two_phase:
    " [Write: this call only creates a proposal and returns { proposalId, expiresAt, preview: { summary, diff, findings } }. Review it, then call mcp_proposals_apply with the proposalId.]",
  own_flow:
    " [Write with its own approval flow: executes directly. Pass dryRun true to get a preview without side effects.]",
};

/** Tools that change something outside OpenGMB (Google, an email, a payment, a public link): a token can only propose them. */
const EXTERNAL_NOTE: Record<"two_phase" | "own_flow", string> = {
  two_phase:
    " [Write outside OpenGMB: this call only creates a proposal and returns { proposalId, expiresAt, preview }. You cannot apply it: mcp_proposals_apply is refused for it. A person must approve this in OpenGMB (the Agents page); tell them the proposal is waiting.]",
  own_flow:
    " [Write outside OpenGMB: refused to API tokens, because a person must approve this in OpenGMB. Pass dryRun true to get a preview.]",
};

const noteFor = (name: string, mode: "two_phase" | "own_flow") =>
  (isExternalEffect(name) ? EXTERNAL_NOTE : WRITE_NOTE)[mode];

/**
 * One MCP tool per action plus the read-only resources. Names and schemas are derived from the
 * registry; every write goes through executeToolCall (propose / dry-run gate), never straight to
 * executeAction. Write tools additionally accept `dryRun` and may return a proposal or preview
 * instead of the action's own output.
 */
export function createMcpServer(opts: {
  db: Db;
  actor: Actor;
  actions: readonly AnyAction[];
}): McpServer {
  const server = new McpServer({ name: "opengmb", version: "0.0.0" });
  registerResources(server, opts);
  for (const action of opts.actions) {
    const mode = approvalOf(action);
    server.registerTool(
      toolNameFor(action.name),
      {
        description: mode ? action.description + noteFor(action.name, mode) : action.description,
        inputSchema: mode ? { ...action.input.shape, dryRun } : action.input.shape,
        outputSchema: mode
          ? z.object(action.output.shape).partial().extend({
              proposalId: z.string().optional(),
              expiresAt: z.string().optional(),
              dryRun: z.boolean().optional(),
              preview: z.unknown().optional(),
            }).shape
          : action.output.shape,
        annotations: { readOnlyHint: action.kind === "read" },
      },
      async (args: unknown) => {
        try {
          const data = (await executeToolCall(
            opts.db,
            opts.actor,
            action.name,
            args,
            opts.actions,
          )) as Record<string, unknown>;
          return { structuredContent: data, content: [asText(data)] };
        } catch (e) {
          if (e instanceof CoreError) {
            return { isError: true, content: [asText({ code: e.code, message: e.message })] };
          }
          console.error(`[mcp] ${action.name} failed`, e);
          void recordError(opts.db, "mcp", toErrorInfo(e));
          return {
            isError: true,
            content: [asText({ code: "INTERNAL", message: "Internal error" })],
          };
        }
      },
    );
  }
  return server;
}
