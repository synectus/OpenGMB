import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { reportDefinitions, reportRuns, reportShareLinks, workspaces, type Db, type Tx } from "@opengmb/db";
import type { DateFormat } from "../config/time-zones";
import { writeAudit } from "../audit";
import { loadBranding } from "../branding";
import { parseRunContent, type RunContent } from "./content";
import { reportPeriodLabel } from "./labels";
import { brandingOf } from "./run";

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** 32 random bytes, base64url: 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Filename for a run's PDF: the definition name and period, ASCII only. */
export function reportFilename(name: string, periodStart: string, periodEnd: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "report";
  return `${slug}-${periodStart}-to-${periodEnd}.pdf`;
}

/**
 * Create a link for a finished run. The token is returned once and only its sha256 is stored. The
 * caller writes the audit row (it differs for a user and for the monthly schedule).
 */
export async function createShareLink(
  tx: Tx,
  p: {
    orgId: string;
    reportRunId: string;
    createdBy: string | null;
    expiresInDays: number;
    now?: Date;
  },
): Promise<{ linkId: string; token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date((p.now ?? new Date()).getTime() + p.expiresInDays * 86_400_000);
  const [row] = await tx
    .insert(reportShareLinks)
    .values({
      orgId: p.orgId,
      reportRunId: p.reportRunId,
      tokenHash: hashToken(token),
      expiresAt,
      createdBy: p.createdBy,
    })
    .returning({ id: reportShareLinks.id });
  return { linkId: row!.id, token, expiresAt };
}

export function shareUrl(token: string, baseUrl = process.env.BETTER_AUTH_URL ?? ""): string {
  return `${baseUrl.replace(/\/$/, "")}/r/${token}`;
}

export type SharedReport =
  | { status: "ok"; pdf: Buffer; filename: string; runId: string }
  | { status: "invalid" | "expired" | "revoked" | "not_ready" };

/**
 * Public access by token, no login. A valid, unexpired, unrevoked link on a finished run returns the
 * PDF and writes an audit row in the same transaction (surface ui, actor_type system, after {runId}).
 * An expired, revoked or not-ready link is audited as a denial (the org is known from the link). An
 * unknown token returns `invalid` and writes nothing: there is no org to audit against.
 */
export async function openSharedReport(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<SharedReport> {
  if (!TOKEN_RE.test(token)) return { status: "invalid" };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        linkId: reportShareLinks.id,
        orgId: reportShareLinks.orgId,
        expiresAt: reportShareLinks.expiresAt,
        revokedAt: reportShareLinks.revokedAt,
        runId: reportRuns.id,
        status: reportRuns.status,
        pdf: reportRuns.pdf,
        periodStart: reportRuns.periodStart,
        periodEnd: reportRuns.periodEnd,
        name: reportDefinitions.name,
      })
      .from(reportShareLinks)
      .innerJoin(reportRuns, eq(reportRuns.id, reportShareLinks.reportRunId))
      .innerJoin(reportDefinitions, eq(reportDefinitions.id, reportRuns.definitionId))
      .where(eq(reportShareLinks.tokenHash, hashToken(token)));
    if (!row) return { status: "invalid" } as const;
    const denied = row.revokedAt
      ? "revoked"
      : row.expiresAt.getTime() <= now.getTime()
        ? "expired"
        : row.status !== "done" || !row.pdf
          ? "not_ready"
          : null;
    await writeAudit(tx, {
      orgId: row.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "ui",
      action: denied ? "reports.share_denied" : "reports.share_accessed",
      entityType: "report_share_link",
      entityId: row.linkId,
      after: denied ? { runId: row.runId, reason: denied } : { runId: row.runId },
    });
    if (denied) return { status: denied } as const;
    return {
      status: "ok",
      pdf: row.pdf!,
      filename: reportFilename(row.name, row.periodStart, row.periodEnd),
      runId: row.runId,
    } as const;
  });
}

export type ShareBrand = { agencyName: string; colour: string | null; logoUrl: string | null };

/**
 * The agency brand for the share page: the run's snapshot of the
 * definition branding, then the definition's current branding, then the org branding. The logo
 * only exists on the org.
 */
export async function resolveBrand(
  tx: Tx,
  orgId: string,
  snapshot: { agencyName?: string; colour?: string } | null,
  current: { agencyName?: string; colour?: string },
): Promise<ShareBrand> {
  const org = await loadBranding(tx, orgId);
  return {
    agencyName: snapshot?.agencyName?.trim() || current.agencyName?.trim() || org.agencyName,
    colour: snapshot?.colour ?? current.colour ?? org.primaryColor ?? null,
    logoUrl: org.logoUrl,
  };
}

export type SharedReportView =
  | {
      status: "ok";
      runId: string;
      title: string;
      periodLabel: string;
      expiresAt: string;
      pdfBytes: number | null;
      content: RunContent | null;
      /** The AI summary of the run (A7), the same text as in the PDF; null when the report has none. */
      summary: string | null;
      brand: ShareBrand;
      /** The report's workspace display settings, so the public page shows dates the way the client set them. */
      timeZone: string;
      dateFormat: DateFormat;
    }
  | { status: "expired" | "revoked"; brand: ShareBrand }
  | { status: "invalid" | "not_ready" };

/**
 * The public landing page's data. Same checks as openSharedReport, but never reads the PDF bytes.
 * A view of a valid link audits reports.share_viewed {runId}; expired, revoked and not-ready links
 * audit reports.share_denied {runId, reason, view: "page"}. An unknown token writes nothing and
 * returns nothing (there is no org to audit against, and nothing may be revealed).
 */
export async function viewSharedReport(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<SharedReportView> {
  if (!TOKEN_RE.test(token)) return { status: "invalid" };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        linkId: reportShareLinks.id,
        orgId: reportShareLinks.orgId,
        expiresAt: reportShareLinks.expiresAt,
        revokedAt: reportShareLinks.revokedAt,
        runId: reportRuns.id,
        status: reportRuns.status,
        pdfBytes: reportRuns.pdfBytes,
        content: reportRuns.content,
        summary: reportRuns.summary,
        periodStart: reportRuns.periodStart,
        periodEnd: reportRuns.periodEnd,
        name: reportDefinitions.name,
        branding: reportDefinitions.branding,
        timeZone: workspaces.timeZone,
        dateFormat: workspaces.dateFormat,
      })
      .from(reportShareLinks)
      .innerJoin(reportRuns, eq(reportRuns.id, reportShareLinks.reportRunId))
      .innerJoin(reportDefinitions, eq(reportDefinitions.id, reportRuns.definitionId))
      .innerJoin(workspaces, eq(workspaces.id, reportDefinitions.workspaceId))
      .where(eq(reportShareLinks.tokenHash, hashToken(token)));
    if (!row) return { status: "invalid" } as const;
    const denied = row.revokedAt
      ? "revoked"
      : row.expiresAt.getTime() <= now.getTime()
        ? "expired"
        : row.status !== "done"
          ? "not_ready"
          : null;
    await writeAudit(tx, {
      orgId: row.orgId,
      actorUserId: null,
      actorType: "system",
      surface: "ui",
      action: denied ? "reports.share_denied" : "reports.share_viewed",
      entityType: "report_share_link",
      entityId: row.linkId,
      after: denied ? { runId: row.runId, reason: denied, view: "page" } : { runId: row.runId },
    });
    if (denied === "not_ready") return { status: "not_ready" } as const;
    const content = parseRunContent(row.content);
    const brand = await resolveBrand(tx, row.orgId, content?.branding ?? null, brandingOf(row));
    if (denied) return { status: denied, brand } as const;
    return {
      status: "ok",
      runId: row.runId,
      title: content?.title ?? row.name,
      periodLabel: content?.periodLabel ?? reportPeriodLabel(row.periodStart, row.periodEnd),
      expiresAt: row.expiresAt.toISOString(),
      pdfBytes: row.pdfBytes,
      content,
      summary: row.summary,
      brand,
      timeZone: row.timeZone,
      dateFormat: row.dateFormat,
    } as const;
  });
}
