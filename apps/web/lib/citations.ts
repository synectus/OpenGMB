// Pure logic for the citation tracker page. Client-safe.
export const CITATION_STATUSES = ["not_started", "submitted", "live", "needs_fix"] as const;
export type CitationStatus = (typeof CITATION_STATUSES)[number];
export type StatusFilter = "all" | CitationStatus;

export const parseFilter = (v: string | undefined | null): StatusFilter =>
  (CITATION_STATUSES as readonly string[]).includes(v ?? "") ? (v as CitationStatus) : "all";

export function summarize(statuses: readonly CitationStatus[]) {
  const n = (s: CitationStatus) => statuses.filter((x) => x === s).length;
  return {
    total: statuses.length,
    live: n("live"),
    submitted: n("submitted"),
    needsFix: n("needs_fix"),
    notStarted: n("not_started"),
  };
}

export const matchesFilter = (status: CitationStatus, f: StatusFilter) => f === "all" || status === f;

/** Share of sites that are live, 0 to 100, for the progress bar. */
export const livePercent = (live: number, total: number) => (total === 0 ? 0 : Math.round((live / total) * 100));
