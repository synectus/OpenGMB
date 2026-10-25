// Pure helpers for /audit. Client-safe.

export const AUDIT_SURFACES = [
  { key: "ui", label: "App" },
  { key: "mcp", label: "API token" },
  { key: "worker", label: "Worker" },
  { key: "cli", label: "Command line" },
] as const;
export type AuditSurface = (typeof AUDIT_SURFACES)[number]["key"];

/** Rows per page. The page asks core for one more to know whether "Older" exists. */
export const AUDIT_PAGE = 50;

export function surfaceLabel(s: string): string {
  return AUDIT_SURFACES.find((x) => x.key === s)?.label ?? s;
}

export function parseSurface(v: string | undefined): AuditSurface | undefined {
  return AUDIT_SURFACES.find((x) => x.key === v)?.key;
}

export function parseBefore(v: string | undefined): number | undefined {
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 && Number.isSafeInteger(n) ? n : undefined;
}

export function auditHref(o: { surface?: string; actor?: string; before?: number }): string {
  const q = new URLSearchParams();
  if (o.surface) q.set("surface", o.surface);
  if (o.actor) q.set("actor", o.actor);
  if (o.before !== undefined) q.set("before", String(o.before));
  const s = q.toString();
  return s ? `/audit?${s}` : "/audit";
}

/** Given up to page+1 rows (newest first), the beforeId for "Older", or null when none remain. */
export function olderBefore(rows: { id: number }[], page: number): number | null {
  return rows.length > page ? rows[page - 1]!.id : null;
}

export function pageNote(before: number | undefined, shown: number): string {
  if (shown === 0) return "";
  const rows = shown === 1 ? "1 row" : `${shown} rows`;
  return before === undefined ? `Showing the newest ${rows}.` : `Showing ${rows} older than #${before}.`;
}

export function actorLabel(e: {
  actorType: string;
  actorName: string | null;
  actorUserId: string | null;
}): string {
  if (e.actorType === "system") return "System";
  const who = e.actorName ?? e.actorUserId ?? "Unknown";
  return e.actorType === "api_token" ? `${who} (API token)` : who;
}

export function changeJson(v: unknown): string {
  return v === null || v === undefined ? "Nothing" : JSON.stringify(v, null, 2);
}

/** The audit log keeps stored names such as "workspace.create"; the page shows the client word. */
export const auditName = (s: string): string => s.replace(/workspace/g, "client");
