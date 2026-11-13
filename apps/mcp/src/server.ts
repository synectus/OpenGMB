import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CoreError,
  approvalOf,
  destructiveHintFor,
  executeToolCall,
  isExternalEffect,
  toolNameFor,
  toolTitleFor,
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
    " [Write: returns a proposal { proposalId, expiresAt, preview: { summary, diff, findings } } and changes nothing until mcp_proposals_apply runs it.]",
  own_flow:
    " [Write with its own approval flow: runs directly. With dryRun true it returns a preview and changes nothing.]",
};

/** Tools that change something outside OpenGMB (Google, an email, a payment, a public link): a token can only propose them. */
const EXTERNAL_NOTE: Record<"two_phase" | "own_flow", string> = {
  two_phase:
    " [Write outside OpenGMB: returns a proposal { proposalId, expiresAt, preview }. mcp_proposals_apply refuses it; it runs only after a person approves it on the Agents page in OpenGMB.]",
  own_flow:
    " [Write outside OpenGMB: refused to API tokens and connected apps, because a person approves it in OpenGMB. With dryRun true it returns a preview.]",
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
        title: toolTitleFor(action.name),
        annotations: {
          title: toolTitleFor(action.name),
          readOnlyHint: action.kind === "read",
          destructiveHint: destructiveHintFor(action),
        },
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
