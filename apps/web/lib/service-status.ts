// Public status page logic (H7). Pure mapping plus a short cache. Nothing here knows how the signals
// are read (readServiceSignals in @opengmb/core), and nothing leaves it except a coarse state per part: no ids,
// versions, host names, counts or error text.

import { MONITORING, type ServiceSignals } from "@opengmb/core";

export type PartState = "up" | "delayed" | "down" | "unknown";
export type PublicStatus = {
  checkedAt: string;
  parts: { key: "web" | "worker" | "database"; label: string; state: PartState }[];
  overall: "ok" | "degraded" | "down";
};

/** The worker is "running" while its heartbeat is newer than H2's threshold (the same one that raises the alert). */
export const WORKER_STALE_MS = MONITORING.workerStaleMs;
/** Cached for this long, so the page cannot be used to put load on the database. */
export const STATUS_CACHE_MS = 30_000;

export const STATE_TEXT: Record<PartState, string> = {
  up: "Running normally",
  delayed: "Delayed",
  down: "Not working",
  unknown: "Not reporting yet",
};

export function workerState(last: Date | null, now: Date): PartState {
  if (!last) return "unknown";
  return now.getTime() - last.getTime() <= WORKER_STALE_MS ? "up" : "delayed";
}

export function toPublicStatus(s: ServiceSignals | null, now: Date): PublicStatus {
  // A null signal set means the read itself failed: the database cannot be reached.
  const database: PartState = s?.databaseUp ? "up" : "down";
  const worker: PartState = database === "down" ? "unknown" : workerState(s?.workerLastActivityAt ?? null, now);
  const parts: PublicStatus["parts"] = [
    { key: "web", label: "Web app", state: "up" },
    { key: "worker", label: "Background worker", state: worker },
    { key: "database", label: "Database", state: database },
  ];
  const overall = database === "down" ? "down" : worker === "up" ? "ok" : "degraded";
  return { checkedAt: now.toISOString(), parts, overall };
}

export const OVERALL_TEXT: Record<PublicStatus["overall"], string> = {
  ok: "Everything is running normally.",
  degraded: "Some background work may be late. The app itself is up.",
  down: "We are having a problem. Please try again in a few minutes.",
};

/** A cache with a single in-flight read: callers inside the window share one result and one query. */
export function createStatusCache(
  read: () => Promise<ServiceSignals>,
  ttlMs = STATUS_CACHE_MS,
  clock: () => number = Date.now,
) {
  let value: { at: number; status: PublicStatus } | null = null;
  let inflight: Promise<PublicStatus> | null = null;
  return function get(): Promise<PublicStatus> {
    if (value && clock() - value.at < ttlMs) return Promise.resolve(value.status);
    inflight ??= read()
      .then((s) => toPublicStatus(s, new Date(clock())))
      .catch(() => toPublicStatus(null, new Date(clock())))
      .then((status) => {
        value = { at: clock(), status };
        return status;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
