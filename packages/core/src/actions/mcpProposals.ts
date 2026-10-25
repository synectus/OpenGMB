import { z } from "zod";
import { mcpProposalStatuses } from "@opengmb/db";
import { applyProposal, cancelProposal, listProposals } from "../proposals";
import { defineAction } from "../registry";

const proposalId = z.uuid();

export const mcpProposalsApply = defineAction({
  name: "mcp.proposals.apply",
  description:
    "Apply a proposal returned by a write tool (phase 2 of propose -> check -> approve -> publish). Single use: it re-checks that the proposal is still pending and unexpired, was created by this API token and user (or, in the web app, that the signed-in person owns the token that created it; then the token must not be revoked and its read-only or client limits still apply), that its stored input is intact, that you are still authorized, and that the policy findings still do not block it; then it runs the write exactly as if you had called the tool, audit rows included. A second apply is CONFLICT. Returns the write's own result.",
  input: z.object({ proposalId }),
  output: z.object({
    proposalId: z.string(),
    status: z.literal("applied"),
    action: z.string(),
    result: z.unknown(),
  }),
  permission: "api_token:manage_own",
  kind: "write",
  // The gate itself: applying is the approval step, so it must not need a proposal.
  approval: "own_flow",
  handler: (ctx, input) => applyProposal(ctx, input.proposalId),
});

export const mcpProposalsCancel = defineAction({
  name: "mcp.proposals.cancel",
  description:
    "Cancel a pending proposal so it can no longer be applied. Only the API token that created it, or its owner signed in to the web app, can cancel it.",
  input: z.object({ proposalId }),
  output: z.object({ proposalId: z.string(), status: z.literal("cancelled") }),
  permission: "api_token:manage_own",
  kind: "write",
  approval: "own_flow",
  handler: (ctx, input) => cancelProposal(ctx, input.proposalId),
});

export const mcpProposalsList = defineAction({
  name: "mcp.proposals.list",
  description:
    "List your own write proposals, newest first, with status (pending, applied, expired, cancelled, failed), expiry, the preview that was shown and the name of the token that made each. Over MCP: this token's proposals. In the web app: every token of the signed-in person. status filters before limit; expired includes pending proposals past their expiry. A failed proposal's error reads CODE: message.",
  input: z.object({
    status: z.enum(mcpProposalStatuses).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: z.object({
    proposals: z.array(
      z.object({
        proposalId: z.string(),
        action: z.string(),
        status: z.enum(mcpProposalStatuses),
        expiresAt: z.string(),
        createdAt: z.string(),
        appliedAt: z.string().nullable(),
        error: z.string().nullable(),
        preview: z.unknown(),
        tokenId: z.string(),
        tokenName: z.string(),
        tokenRevoked: z.boolean(),
      }),
    ),
  }),
  permission: "api_token:manage_own",
  kind: "read",
  async handler(ctx, input) {
    return { proposals: await listProposals(ctx, input) };
  },
});
