import type { TimeFormat } from "./time-format";

export const tokenAccess = (scopes: readonly string[]) =>
  scopes.includes("write") ? "Read & write" : "Read only";

/** "Active", or "Revoked <date>" in the client's date format. The e2e smoke test looks for both words. */
export const tokenStatus = (revokedAt: string | null, tf: TimeFormat) =>
  revokedAt ? `Revoked ${tf.date(revokedAt)}` : "Active";

export const tokenCreated = (iso: string, tf: TimeFormat) => tf.date(iso);

export const tokenLastUsed = (iso: string | null, tf: TimeFormat) => (iso ? tf.dateTime(iso) : "Never");
