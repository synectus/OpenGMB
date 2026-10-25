import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { storedFiles, type Db, type Tx } from "@opengmb/db";

/** A logo ready for a report PDF or an email: small PNG bytes and their pixel size. */
export type ReportLogo = { png: Uint8Array; width: number; height: number };

/** Longest sides a report logo is shrunk to (2x the size it is drawn at, so it stays sharp). */
export const REPORT_LOGO_MAX = { width: 360, height: 96 } as const;

/**
 * PNG, JPEG or WebP bytes -> a small PNG. pdf-lib cannot embed WebP and a 2 MB logo would bloat
 * every PDF and email, so everything is resized and re-encoded. null when the bytes cannot be
 * read: a bad logo must never fail a report.
 */
export async function prepareReportLogo(bytes: Uint8Array): Promise<ReportLogo | null> {
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize(REPORT_LOGO_MAX.width, REPORT_LOGO_MAX.height, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { png: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** The organization's own agency logo (G2 slot: workspace null), prepared. Scoped by orgId only. */
export async function loadReportLogo(db: Db | Tx, orgId: string): Promise<ReportLogo | null> {
  const [row] = await db
    .select({ bytes: storedFiles.bytes })
    .from(storedFiles)
    .where(and(eq(storedFiles.orgId, orgId), isNull(storedFiles.workspaceId), eq(storedFiles.kind, "logo")));
  return row ? prepareReportLogo(row.bytes) : null;
}
