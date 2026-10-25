import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CoreError,
  MCP_CONFIG,
  MCP_LEGACY_RESOURCES,
  MCP_RESOURCES,
  executeAction,
  type Actor,
  type AnyAction,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

type Ctx = { db: Db; actor: Actor; actions: readonly AnyAction[] };

export const RESOURCE_URIS = {
  reviewQueue: "opengmb://reviews/queue",
  pendingUpdates: "opengmb://google/pending-updates",
  auditRecent: "opengmb://audit/recent",
} as const;

/** Resources never touch tables: each one is composed from existing read actions, so core's
 *  permission and workspace-scope checks apply exactly as they do for the matching tools. */
const read = (c: Ctx, name: string, input: unknown) =>
  executeAction(c.db, c.actor, name, input, c.actions) as Promise<Record<string, unknown>>;

const rows = (v: Record<string, unknown>, key: string) => v[key] as unknown[];

const BUILDERS: Record<string, (c: Ctx) => Promise<unknown>> = {
  [RESOURCE_URIS.reviewQueue]: async (c) => {
    const limit = MCP_CONFIG.queueRowsPerStatus;
    const replyStatuses = ["pending_approval", "blocked", "conflict"] as const;
    const postStatuses = ["pending_approval", "blocked"] as const;
    const replies: Record<string, unknown[]> = {};
    for (const status of replyStatuses) {
      replies[status] = rows(await read(c, "reviewReplies.listQueue", { status, limit }), "items");
    }
    const posts: Record<string, unknown[]> = {};
    for (const status of postStatuses) {
      posts[status] = rows(await read(c, "posts.list", { status, limit }), "posts");
    }
    return { replies, posts };
  },
  [RESOURCE_URIS.pendingUpdates]: async (c) => ({
    changes: rows(await read(c, "profile.changes.list", { status: "open", limit: 200 }), "changes"),
  }),
  [RESOURCE_URIS.auditRecent]: async (c) => ({
    entries: rows(await read(c, "audit.list", { limit: MCP_CONFIG.recentAuditRows }), "entries"),
  }),
};

async function answer(c: Ctx, uri: string, href: string) {
  try {
    const data = await BUILDERS[uri]!(c);
    return { contents: [{ uri: href, mimeType: "application/json", text: JSON.stringify(data) }] };
  } catch (e) {
    if (e instanceof CoreError) {
      throw new McpError(ErrorCode.InvalidRequest, `${e.code}: ${e.message}`, {
        code: e.code,
      });
    }
    console.error(`[mcp] resource ${uri} failed`, e);
    throw new McpError(ErrorCode.InternalError, "Internal error");
  }
}

/** Read-only context for AI clients. Resources stay readable with a read-only token. */
export function registerResources(server: McpServer, c: Ctx) {
  for (const uri of Object.keys(BUILDERS)) {
    const info = MCP_RESOURCES.find((r) => r.uri === uri);
    if (!info) throw new Error(`MCP resource ${uri} has no entry in MCP_RESOURCES`);
    server.registerResource(
      info.name,
      uri,
      { description: info.description, mimeType: "application/json" },
      (url) => answer(c, uri, url.href),
    );
  }
  // No list callback: readable, never listed in resources/list.
  const L = MCP_LEGACY_RESOURCES;
  server.registerResource(
    "legacy-addresses",
    new ResourceTemplate(`${L.scheme}://{group}/{name}`, { list: undefined }),
    { description: L.description, mimeType: "application/json" },
    (url, vars) => {
      const current = `${L.currentScheme}://${String(vars.group)}/${String(vars.name)}`;
      if (!BUILDERS[current]) throw new McpError(ErrorCode.InvalidParams, `Resource ${url.href} not found`);
      console.info(`[mcp] legacy resource address read: ${url.href}`);
      return answer(c, current, url.href);
    },
  );
}
