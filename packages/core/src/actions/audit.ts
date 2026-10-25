import { and, asc, desc, eq, gt, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { auditLog, auditSurface, users } from "@opengmb/db";
import { canonicalJson, getAuditCheckpoint, verifyAuditChain } from "../audit";
import { defineAction } from "../registry";

export const auditList = defineAction({
  name: "audit.list",
  description:
    "List audit log entries for the caller's organization, newest first, with the acting user's name (null for system rows) and each row's before/after. Optional filters, applied before limit: surface (ui, mcp, worker, cli) and actorUserId. Pass beforeId (the smallest id seen) with the same filters to page.",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(50),
    beforeId: z.number().int().optional(),
    surface: z.enum(auditSurface.enumValues).optional(),
    actorUserId: z.string().min(1).optional(),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        id: z.number(),
        createdAt: z.string(),
        actorUserId: z.string().nullable(),
        actorName: z.string().nullable(),
        actorType: z.string(),
        surface: z.string(),
        action: z.string(),
        entityType: z.string(),
        entityId: z.string(),
        before: z.unknown(),
        after: z.unknown(),
        hash: z.string(),
      }),
    ),
  }),
  permission: "audit:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const rows = await tx
      .select({ r: auditLog, actorName: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(
        and(
          eq(auditLog.orgId, actor.orgId),
          input.beforeId === undefined ? undefined : lt(auditLog.id, input.beforeId),
          input.surface ? eq(auditLog.surface, input.surface) : undefined,
          input.actorUserId ? eq(auditLog.actorUserId, input.actorUserId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(input.limit);
    return {
      entries: rows.map(({ r, actorName }) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actorUserId: r.actorUserId,
        actorName,
        actorType: r.actorType,
        surface: r.surface,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        hash: r.hash,
      })),
    };
  },
});

const checkpointOut = z
  .object({
    orgId: z.string(),
    lastId: z.number(),
    lastHash: z.string(),
    rowCount: z.number(),
    updatedAt: z.string(),
    signature: z.string(),
  })
  .nullable();

export const auditVerify = defineAction({
  name: "audit.verify",
  description:
    "Verify the caller's organization audit chain: recompute every row hash and link, and compare the chain head (last id, hash, row count) with the signed checkpoint. checkpoint is ok, missing (rows exist but no checkpoint yet), invalid_signature, or mismatch (rows were deleted or truncated).",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    checked: z.number(),
    breaks: z.array(
      z.object({
        id: z.number().optional(),
        kind: z.enum([
          "hash_mismatch",
          "prev_link",
          "checkpoint_missing",
          "checkpoint_signature",
          "checkpoint_mismatch",
        ]),
        detail: z.string(),
      }),
    ),
    checkpoint: z.enum(["ok", "missing", "invalid_signature", "mismatch"]),
  }),
  permission: "audit:read",
  kind: "read",
  async handler({ tx, actor }) {
    const { ok, checked, breaks, checkpoint } = await verifyAuditChain(tx, actor.orgId);
    return { ok, checked, breaks, checkpoint };
  },
});

const EXPORT_COLUMNS = [
  "id",
  "created_at",
  "actor_user_id",
  "actor_type",
  "surface",
  "action",
  "entity_type",
  "entity_id",
  "before",
  "after",
  "prev_hash",
  "hash",
] as const;

/** RFC 4180: quote a field containing a comma, quote, CR or LF; double embedded quotes. */
function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const auditExport = defineAction({
  name: "audit.export",
  description:
    "Export the caller's organization audit log as CSV or JSON, ordered by id ascending. from is inclusive and to is exclusive, both ISO datetimes compared in UTC at millisecond precision. limit defaults to 5000 (max 5000); when truncated is true, pass nextAfterId as afterId to continue. before/after are canonical JSON. The result includes the current signed checkpoint, so a copy of the signed chain head leaves the system with each export. Each export is itself recorded as an audit.export audit row.",
  input: z.object({
    format: z.enum(["csv", "json"]),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(5000).default(5000),
    afterId: z.number().int().optional(),
  }),
  output: z.object({
    format: z.enum(["csv", "json"]),
    content: z.string(),
    rowCount: z.number(),
    truncated: z.boolean(),
    nextAfterId: z.number().optional(),
    checkpoint: checkpointOut,
  }),
  permission: "audit:read",
  // Kind stays "read": no tenant data changes. The executor gives read actions the same
  // transaction and ctx.audit as write actions (it only asserts an audit row for "write"),
  // so the handler records the export explicitly below.
  kind: "read",
  async handler({ tx, actor, audit }, input) {
    const from = input.from ? new Date(input.from) : undefined;
    const to = input.to ? new Date(input.to) : undefined;
    const rows = await tx
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, actor.orgId),
          input.afterId === undefined ? undefined : gt(auditLog.id, input.afterId),
          from ? gte(auditLog.createdAt, from) : undefined,
          to ? lt(auditLog.createdAt, to) : undefined,
        ),
      )
      .orderBy(asc(auditLog.id))
      .limit(input.limit + 1);
    const truncated = rows.length > input.limit;
    const page = truncated ? rows.slice(0, input.limit) : rows;
    const json = (v: unknown) => (v === null || v === undefined ? null : canonicalJson(v));
    const flat = page.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      actor_user_id: r.actorUserId,
      actor_type: r.actorType,
      surface: r.surface,
      action: r.action,
      entity_type: r.entityType,
      entity_id: r.entityId,
      before: json(r.before),
      after: json(r.after),
      prev_hash: r.prevHash,
      hash: r.hash,
    }));
    const content =
      input.format === "csv"
        ? [
            EXPORT_COLUMNS.join(","),
            ...flat.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(",")),
          ].join("\r\n") + "\r\n"
        : JSON.stringify(
            page.map((r, i) => ({ ...flat[i]!, before: r.before ?? null, after: r.after ?? null })),
            null,
            2,
          );

    await audit({
      action: "audit.export",
      entityType: "audit_log",
      entityId: actor.orgId,
      after: {
        format: input.format,
        from: input.from ?? null,
        to: input.to ?? null,
        afterId: input.afterId ?? null,
        rowCount: page.length,
        truncated,
      },
    });
    // Read after our audit write: we hold the org lock, so this is the head including that row.
    const cp = await getAuditCheckpoint(tx, actor.orgId);
    return {
      format: input.format,
      content,
      rowCount: page.length,
      truncated,
      ...(truncated ? { nextAfterId: page.at(-1)!.id } : {}),
      checkpoint: cp ? { ...cp, updatedAt: cp.updatedAt.toISOString() } : null,
    };
  },
});
