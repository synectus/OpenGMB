/** Whole days from an ISO time to `now` (UTC days, never negative); null when there is no time. */
export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** The categories to show in a table cell: the primary first, then the additional ones, up to `max`, with how many were left out. */
export function categoryCell(primary: string | null, additional: readonly string[], max = 3): { shown: string[]; more: number } {
  const all = [...(primary ? [primary] : []), ...additional];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}
