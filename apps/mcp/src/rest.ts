import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  CoreError,
  approvalOf,
  executeToolCall,
  isExternalEffect,
  recordError,
  toErrorInfo,
  type Actor,
  type AnyAction,
} from "@opengmb/core";
import type { Db } from "@opengmb/db";

/**
 * REST v1: the same actions, tokens, scopes and rate limits as the MCP endpoint, over plain JSON.
 *
 *   GET  /v1/actions        every action: name, kind, approval, description, inputSchema
 *   POST /v1/actions/<name> run one action; the JSON body is its input
 *
 * Every call goes through `executeToolCall`, the function MCP uses: a read executes, a two_phase
 * write returns { proposalId, expiresAt, preview } and changes nothing until
 * POST /v1/actions/mcp.proposals.apply, an own_flow write executes (dryRun previews). REST never
 * calls `executeAction` itself, so a token has exactly the power it has over MCP (a test greps this
 * file for that). Audit rows keep surface "mcp": see the note on Actor in packages/core/src/actor.ts.
 */

export const API_VERSION = "1";
export const MAX_BODY_BYTES = 1024 * 1024;

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  CONFLICT: 409,
  NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
};

type ErrorBody = { error: { code: string; message: string; issues?: unknown } };

export function restSend(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "syngmb-api-version": API_VERSION,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function restError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  issues?: unknown,
) {
  const body: ErrorBody = { error: { code, message, ...(issues ? { issues } : {}) } };
  restSend(res, status, body, headers);
}

class BodyTooLarge extends Error {}
class BadBody extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadBody("Body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadBody("Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** JSON Schema of an action's input (what a caller may send), cached per action object. */
const schemaCache = new WeakMap<AnyAction, unknown>();
export function inputSchemaOf(action: AnyAction): unknown {
  let s = schemaCache.get(action);
  if (s === undefined) {
    s = z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" });
    schemaCache.set(action, s);
  }
  return s;
}

export function describeAction(action: AnyAction) {
  return {
    name: action.name,
    kind: action.kind,
    approval: approvalOf(action),
    /** True when the action changes something outside OpenGMB: a token can propose it, a person approves it in the app. */
    needsPerson: action.kind === "write" && isExternalEffect(action.name),
    description: action.description,
    inputSchema: inputSchemaOf(action),
  };
}

/** Handle an authenticated /v1/* request. The caller has already verified the token and rate limit. */
export async function handleRest(opts: {
  db: Db;
  actor: Actor;
  actions: readonly AnyAction[];
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
}): Promise<void> {
  const { db, actor, actions, req, res, path } = opts;
  try {
    if (path === "/v1/actions") {
      if (req.method !== "GET") {
        return restError(res, 405, "METHOD_NOT_ALLOWED", "Use GET", { allow: "GET" });
      }
      return restSend(res, 200, { data: { actions: actions.map(describeAction) } });
    }
    const m = /^\/v1\/actions\/([^/]+)$/.exec(path);
    if (!m) return restError(res, 404, "NOT_FOUND", "Unknown path");
    if (req.method !== "POST") {
      return restError(res, 405, "METHOD_NOT_ALLOWED", "Use POST", { allow: "POST" });
    }
    let name: string;
    try {
      name = decodeURIComponent(m[1]!);
    } catch {
      return restError(res, 404, "NOT_FOUND", "Unknown action");
    }
    if (!actions.some((a) => a.name === name)) {
      return restError(res, 404, "NOT_FOUND", `Unknown action ${name.slice(0, 100)}`);
    }
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        // Stop reading: the connection is closed after the answer.
        return restError(res, 413, "PAYLOAD_TOO_LARGE", "Body is larger than 1 MB", {
          connection: "close",
        });
      }
      if (e instanceof BadBody) return restError(res, 400, "INVALID_JSON", e.message);
      throw e;
    }
    const data = await executeToolCall(db, actor, name, body, actions);
    return restSend(res, 200, { data });
  } catch (e) {
    if (e instanceof CoreError) {
      const issues =
        "issues" in e && Array.isArray(e.issues)
          ? (e.issues as { path: unknown[]; message: string; code: string }[]).map((i) => ({
              path: i.path,
              message: i.message,
              code: i.code,
            }))
          : undefined;
      return restError(res, STATUS[e.code] ?? 500, e.code, e.message, {}, issues);
    }
    console.error("[rest] request failed", e);
    void recordError(db, "mcp", toErrorInfo(e));
    if (!res.headersSent) restError(res, 500, "INTERNAL", "Internal error");
    else res.end();
  }
}
