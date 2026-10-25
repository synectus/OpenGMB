import type { Permission } from "../permissions";

/** MCP surface settings. Our own choices, not external numbers. */
export const MCP_CONFIG = {
  /** How long a two-phase write proposal can be applied after it was created. */
  proposalTtlMs: 15 * 60 * 1000,
  /** Rows the opengmb://audit/recent resource returns. */
  recentAuditRows: 100,
  /** Rows per status the opengmb://reviews/queue resource returns. */
  queueRowsPerStatus: 50,
} as const;

/** A read-only MCP resource: what it holds and the permission the reads behind it need. */
export type McpResourceInfo = {
  name: string;
  uri: string;
  permission: Permission;
  /** One plain sentence for people (the AI agents page). */
  holds: string;
  /** What the agent sees in resources/list. */
  description: string;
};

/**
 * The resources apps/mcp registers (it builds each one from read actions). `permission` must be
 * what those reads need; apps/mcp/src/surface.test.ts checks it role by role.
 */
export const MCP_RESOURCES: readonly McpResourceInfo[] = [
  {
    name: "review-queue",
    uri: "opengmb://reviews/queue",
    permission: "review:approve",
    holds:
      "Replies pending approval, blocked or conflicted, and posts pending approval or blocked.",
    description:
      "Replies (pending_approval, blocked, conflict) and posts (pending_approval, blocked) waiting for attention, in the token's workspace scope. Needs review:approve.",
  },
  {
    name: "google-pending-updates",
    uri: "opengmb://google/pending-updates",
    permission: "location:read",
    holds: "Open profile changes: edits made outside OpenGMB and updates Google suggested.",
    description:
      "Open profile changes: edits found outside OpenGMB and Google-suggested updates (googleSuggested true). Needs location:read.",
  },
  {
    name: "audit-recent",
    uri: "opengmb://audit/recent",
    permission: "audit:read",
    holds: `The last ${MCP_CONFIG.recentAuditRows} audit rows.`,
    description: `The last ${MCP_CONFIG.recentAuditRows} audit log rows of the organization, newest first. Needs audit:read.`,
  },
];

/**
 * Resource addresses before the rename to OpenGMB (2026-10-24). Reads are still answered, as the
 * opengmb:// resource with the same path, so agents and saved prompts that name them keep working.
 * They are not listed. Each read logs "[mcp] legacy resource address read: <uri>"; remove this only
 * after the mcp log shows no such line for 90 days.
 */
export const MCP_LEGACY_RESOURCES = {
  scheme: "syngmb",
  currentScheme: "opengmb",
  renamedOn: "2026-10-24",
  description: "Addresses from before the rename to OpenGMB (syngmb://). Same data as the opengmb:// resources; use those.",
} as const;
