// Pure logic for profile changes (the location Changes tab; plan 3G (Part B)'s Alerts reuses it).
// Client-safe: only types come from core.
import type { profileChangesList } from "@opengmb/core";
import { plainValue, profileFieldLabel, statusWords } from "./labels";
import { approvalsHref, itemKey } from "./approvals";
import type { TimeFormat } from "./time-format";

export type ChangeData = Awaited<ReturnType<(typeof profileChangesList)["handler"]>>["changes"][number];
export type ChangeStatus = ChangeData["status"];
export type StatusFilter = ChangeStatus | "all";
type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const STATUSES: readonly ChangeStatus[] = ["open", "accepted", "reverted", "dismissed"];
export const parseStatus = (v: string | undefined): StatusFilter =>
  v === "all" || STATUSES.includes(v as ChangeStatus) ? (v as StatusFilter) : "open";

export const statusPills = (openCount: number): { key: StatusFilter; label: string }[] => [
  { key: "open", label: `Open (${openCount})` },
  { key: "accepted", label: "Accepted" },
  { key: "reverted", label: "Reverted" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

export const CHANGE_TONE: Record<ChangeStatus, Tone> = {
  open: "warn",
  accepted: "good",
  reverted: "info",
  dismissed: "neutral",
};

/** One value as short text: strings as they are, structures as JSON, nothing as "(empty)". */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return String(plainValue(v));
  const t = JSON.stringify(plainValue(v));
  return t.length > 400 ? `${t.slice(0, 400)}...` : t;
}

export type DiffRow = { field: string; before: string; after: string; mono: boolean };
type Side = ChangeData["before"];
const has = (s: Side, p: string) => (p.startsWith("attributes/") ? p in s.attributes : p in s.fields);
const get = (s: Side, p: string): unknown =>
  p.startsWith("attributes/")
    ? (s.attributes as Record<string, unknown>)[p]
    : (s.fields as Record<string, unknown>)[p];

/** Both sides of one changed path, for the readable summary; null unless both sides have it and one is a structure. */
export function structuredSides(
  c: Pick<ChangeData, "before" | "after">,
  field: string,
): { before: unknown; after: unknown } | null {
  if (!has(c.before, field) || !has(c.after, field)) return null;
  const before = get(c.before, field);
  const after = get(c.after, field);
  const structured = [before, after].some((v) => v !== null && v !== undefined && typeof v === "object");
  return structured ? { before, after } : null;
}

/** One row per changed path; a path absent from a side (Google mask entries) is "(not shown)". */
export function diffRows(c: Pick<ChangeData, "fieldPaths" | "before" | "after">): DiffRow[] {
  return c.fieldPaths.map((field) => {
    const b = has(c.before, field) ? get(c.before, field) : undefined;
    const a = has(c.after, field) ? get(c.after, field) : undefined;
    const text = (side: Side, v: unknown) => (has(side, field) ? showValue(v) : "(not shown)");
    const structured = [b, a].some((v) => v !== null && v !== undefined && typeof v === "object");
    return { field: profileFieldLabel(field), before: text(c.before, b), after: text(c.after, a), mono: structured };
  });
}

const SOURCE: Record<ChangeData["source"], string> = {
  nightly: "nightly snapshot",
  push: "Google notification",
  manual: "manual snapshot",
};
export const foundLine = (c: Pick<ChangeData, "detectedAt" | "source" | "workspaceId">, tf: TimeFormat) =>
  `Found ${tf.dateTime(c.detectedAt, c.workspaceId)} (${SOURCE[c.source]})`;

/** "Accepted by Priya on 2026-10-16 · nothing was written to Google"; null unless accepted or dismissed. */
export function resolvedLine(
  c: Pick<ChangeData, "status" | "resolvedByName" | "resolvedAt" | "workspaceId">,
  tf: TimeFormat,
): string | null {
  if (c.status !== "accepted" && c.status !== "dismissed") return null;
  const verb = c.status === "accepted" ? "Accepted" : "Dismissed";
  const when = c.resolvedAt ? ` on ${tf.date(c.resolvedAt, c.workspaceId)}` : "";
  return `${verb} by ${c.resolvedByName ?? "a team member"}${when} · nothing was written to Google`;
}

export const revertLine = (status: string) =>
  `Revert change set: ${statusWords(status)}${status === "queued" ? " · Waiting for the worker" : ""}`;

const REVERT_TONE: Record<string, Tone> = {
  pending_approval: "warn",
  approved: "good",
  queued: "info",
  applied: "good",
  partially_applied: "warn",
  failed: "bad",
  blocked: "bad",
  cancelled: "neutral",
  draft: "neutral",
};
export const revertTone = (status: string): Tone => REVERT_TONE[status] ?? "neutral";

/**
 * Pending: approve it in /approvals. Later: Bulk edit's change set list, where "Apply to Google"
 * lives (/approvals shows pending items only).
 */
export function revertLink(
  c: Pick<ChangeData, "revertChangeSetId" | "revertChangeSetStatus" | "workspaceId">,
): { href: string; label: string } | null {
  if (!c.revertChangeSetId || !c.revertChangeSetStatus) return null;
  if (c.revertChangeSetStatus === "pending_approval") {
    return {
      href: approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: c.revertChangeSetId }) }),
      label: "Open Approvals",
    };
  }
  return { href: `/locations/bulk-edit?ws=${c.workspaceId}#change-sets`, label: "Open change sets" };
}
