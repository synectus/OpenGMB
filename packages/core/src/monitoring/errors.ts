import { createHash } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import { errorEvents, type Db, type Tx } from "@opengmb/db";
import { MONITORING } from "../config/monitoring";
import { sendAlert } from "./alert";

export type ErrorSource = "web" | "worker" | "mcp";
export type ErrorInfo = { name: string; message: string; stack?: string };

const MAX_MESSAGE = 300;

/**
 * A message that is safe to store and email: connection strings, bearer tokens, key=value secrets,
 * email addresses, long token-like strings and ids are replaced, and it is cut to 300 characters.
 */
export function sanitizeMessage(raw: string): string {
  return raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<url>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\b((?:password|passwd|secret|token|api[_-]?key|authorization|key)\w*)\s*[=:]\s*\S+/gi,
      "$1=<redacted>",
    )
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** The first stack line inside our own code, without line numbers, so the same bug keeps one fingerprint. */
function whereFrom(stack: string | undefined): string {
  const frame = (stack ?? "")
    .split("\n")
    .slice(1)
    .find((l) => l.includes("at ") && !l.includes("node_modules") && !l.includes("node:"));
  return frame ? frame.replace(/:\d+(:\d+)?\)?$/, "").replace(/^.*[\\/]/, "").trim() : "";
}

/** Same error, same fingerprint: digits and ids in the message do not count, the throw site does. */
export function fingerprintOf(source: ErrorSource, info: ErrorInfo): string {
  const shape = sanitizeMessage(info.message).replace(/\d+/g, "N");
  return createHash("sha256")
    .update(`${source}|${info.name}|${shape}|${whereFrom(info.stack)}`)
    .digest("hex")
    .slice(0, 16);
}

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: "NonError", message: typeof e === "string" ? e : "non-error value thrown" };
}

/**
 * Counts one occurrence of a server error and, at most once per alert window per fingerprint,
 * emails it. Never throws (an error reporter that throws hides the original error).
 * Returns whether this call sent the alert.
 */
export async function recordError(
  db: Db,
  source: ErrorSource,
  info: ErrorInfo,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const fingerprint = fingerprintOf(source, info);
    const message = sanitizeMessage(`${info.name}: ${info.message}`);
    await db
      .insert(errorEvents)
      .values({ fingerprint, source, message, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: errorEvents.fingerprint,
        set: { count: sql`${errorEvents.count} + 1`, lastSeenAt: now },
      });
    // One statement claims the alert, so web replicas racing on the same error send one email.
    const windowStart = new Date(now.getTime() - MONITORING.alertWindowMs);
    const claimed = await db
      .update(errorEvents)
      .set({ lastAlertedAt: now })
      .where(
        sql`${errorEvents.fingerprint} = ${fingerprint} and (${errorEvents.lastAlertedAt} is null or ${errorEvents.lastAlertedAt} <= ${windowStart.toISOString()}::timestamptz)`,
      )
      .returning({ count: errorEvents.count });
    if (claimed.length === 0) return false;
    await sendAlert(
      `Error in ${source}`,
      `${message}\n\nSeen ${claimed[0]!.count} time(s) so far. Further repeats of this error are not emailed for ${MONITORING.alertWindowMs / 60000} minutes. See Settings > System health.`,
    );
    return true;
  } catch (e) {
    console.error("[monitoring] could not record an error", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function recentErrors(db: Db | Tx, limit: number = MONITORING.recentErrorsShown) {
  return db.select().from(errorEvents).orderBy(desc(errorEvents.lastSeenAt)).limit(limit);
}

