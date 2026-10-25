/**
 * G2 file storage limits. Our own product decisions, not an external fact.
 * Decided 2026-10-21: each account gets 50 MB. "Account" is the paying organization (the
 * agency), not a user or a client, so every client of an agency shares the one allowance.
 * Set the environment variable STORAGE_QUOTA_MB to change it without a deploy of code.
 */
export const STORAGE_QUOTA_BYTES_PER_ORG = 50 * 1024 * 1024;

/** The quota in bytes: STORAGE_QUOTA_MB when it is a positive number, else the constant above. */
export function storageQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.STORAGE_QUOTA_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : STORAGE_QUOTA_BYTES_PER_ORG;
}

/** Per-file size caps by kind. A logo above 2 MB is a mistake, not a logo. */
export const STORED_FILE_MAX_BYTES = {
  logo: 2 * 1024 * 1024,
  report_asset: 2 * 1024 * 1024,
  post_image_template: 5 * 1024 * 1024,
} as const;

/**
 * Allowed content types, decided from the bytes (the declared type is never trusted). SVG is
 * refused on purpose: it can carry script, and serving it from our origin would run it.
 */
export const STORED_FILE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
