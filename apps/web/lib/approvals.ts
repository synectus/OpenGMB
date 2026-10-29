// Pure logic for /approvals: tabs, item keys, the bulk rules, a sequential approve, key mapping,
// value formatting and chip text. Client-safe: only a type comes from core (erased at build).
import type { approvalsQueue } from "@opengmb/core";
import { plainValue, profileFieldLabel } from "./labels";
import type { TimeFormat } from "./time-format";

export type ApprovalItem = Awaited<ReturnType<typeof approvalsQueue.handler>>["items"][number];
export type ItemType = ApprovalItem["type"];
export type Tab = "all" | ItemType;
export type Counts = { reply: number; post: number; changeset: number; postedit: number; total: number };

export const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "reply", label: "Replies" },
  { key: "post", label: "Posts" },
  { key: "changeset", label: "Profile changes" },
  { key: "postedit", label: "Post edits" },
];
export const TYPE_LABEL: Record<ItemType, string> = {
  reply: "Reply",
  post: "Post",
  changeset: "Profile change",
  postedit: "Post edit",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string => v !== undefined && UUID.test(v);

export function parseTab(v: string | undefined): Tab {
  return TABS.find((t) => t.key === v)?.key ?? "all";
}
export const tabCount = (counts: Counts, tab: Tab): number =>
  tab === "all" ? counts.total : counts[tab];
export const inTab = (items: ApprovalItem[], tab: Tab): ApprovalItem[] =>
  tab === "all" ? items : items.filter((i) => i.type === tab);

export const itemKey = (i: { type: ItemType; id: string }) => `${i.type}:${i.id}`;
export function parseItemKey(v: string | undefined): { type: ItemType; id: string } | null {
  if (!v) return null;
  const at = v.indexOf(":");
  const type = v.slice(0, at);
  const id = v.slice(at + 1);
  if ((type === "reply" || type === "post" || type === "changeset" || type === "postedit") && isUuid(id)) {
    return { type, id };
  }
  return null;
}

/** `Name (address)`, or the name alone when the listing has no address. */
export const locationLabel = (l: { name: string; addressSummary: string | null }): string => {
  const address = l.addressSummary?.trim();
  return address ? `${l.name} (${address})` : l.name;
};
/** The locations an inbox can be narrowed to, once each by id, A to Z by label. */
export function locationOptions(items: ApprovalItem[]): { id: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const l of items.flatMap((i) => i.locations)) byId.set(l.id, locationLabel(l));
  return [...byId].map(([id, label]) => ({ id, label })).sort((x, y) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id));
}
/** Items that touch the location with this id; every item when none is given. */
export const inLocation = (items: ApprovalItem[], loc: string | undefined): ApprovalItem[] =>
  loc ? items.filter((i) => i.locations.some((l) => l.id === loc)) : items;
/** Where an item is for, as labels joined: the list subtitle and the detail Locations row. */
export const itemLocationsText = (item: ApprovalItem): string => item.locations.map(locationLabel).join(", ");

export function approvalsHref(o: { tab?: Tab; ws?: string; loc?: string; item?: string | null }): string {
  const p = new URLSearchParams();
  if (o.tab && o.tab !== "all") p.set("tab", o.tab);
  if (o.ws) p.set("ws", o.ws);
  if (o.loc) p.set("loc", o.loc);
  if (o.item) p.set("item", o.item);
  const qs = p.toString();
  return qs ? `/approvals?${qs}` : "/approvals";
}

export type BulkBlockKey = "cannotApprove" | "blocked" | "warnings";
/** Why this item cannot be approved in bulk (a message key), or null when it is ready. Warnings need a person's eyes. */
export function bulkBlockKey(item: ApprovalItem): BulkBlockKey | null {
  if (!item.can.approve) return "cannotApprove";
  if (item.guardrail.blocked) return "blocked";
  if (item.guardrail.warnings > 0 && !item.guardrail.warningsAcknowledged) return "warnings";
  return null;
}
const BULK_REASON: Record<BulkBlockKey, string> = {
  cannotApprove: "You cannot approve this item",
  blocked: "Blocked by a guardrail: open it to see why",
  warnings: "Has warnings nobody acknowledged: open it and approve it by hand",
};
/** The English text of `bulkBlockKey`, or null when it is ready. */
export function bulkBlockReason(item: ApprovalItem): string | null {
  const k = bulkBlockKey(item);
  return k === null ? null : BULK_REASON[k];
}
export const approvableKeys = (items: ApprovalItem[]): string[] =>
  items.filter((i) => bulkBlockReason(i) === null).map(itemKey);
export function pruneSelection(selected: string[], items: ApprovalItem[]): string[] {
  const ok = new Set(approvableKeys(items));
  return selected.filter((k) => ok.has(k));
}
export const toggleKey = (selected: string[], key: string): string[] =>
  selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
export function toggleAll(selected: string[], items: ApprovalItem[]): string[] {
  const all = approvableKeys(items);
  return all.length > 0 && all.every((k) => selected.includes(k)) ? [] : all;
}
export const approveLabel = (n: number) => `Approve ${n}`;

export type ApproveResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/** Approve one item after another (never in parallel), keep going after a failure, report `CODE: message` per failure. */
export async function approveSequentially(
  items: ApprovalItem[],
  approve: (type: ItemType, id: string) => Promise<ApproveResult>,
  requestFailed = "INTERNAL: request failed",
): Promise<{ approved: string[]; errors: { key: string; title: string; message: string }[] }> {
  const approved: string[] = [];
  const errors: { key: string; title: string; message: string }[] = [];
  for (const item of items) {
    const key = itemKey(item);
    try {
      const r = await approve(item.type, item.id);
      if (r.ok) approved.push(key);
      else errors.push({ key, title: item.title, message: `${r.error.code}: ${r.error.message}` });
    } catch {
      errors.push({ key, title: item.title, message: requestFailed });
    }
  }
  return { approved, errors };
}

export type KeyAction = "approve" | "sendBack" | "next" | "prev";

export function isTypingTarget(
  el: { tagName?: string; isContentEditable?: boolean; type?: string } | null,
): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT") return el.type !== "checkbox" && el.type !== "radio";
  return tag === "TEXTAREA" || tag === "SELECT";
}

/** A S J K. A chord (cmd, ctrl, alt) is never ours: cmd-K opens the command palette. */
export function actionForKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  typing: boolean,
): KeyAction | null {
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case "a":
      return "approve";
    case "s":
      return "sendBack";
    case "j":
      return "next";
    case "k":
      return "prev";
    default:
      return null;
  }
}

export function adjacentKey(keys: string[], current: string | null, dir: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at === -1) return dir === 1 ? keys[0]! : null;
  return keys[at + dir] ?? null;
}
/** Where to go once the current item has left the queue: the next one, else the previous, else the list. */
export const afterActionKey = (keys: string[], current: string | null): string | null =>
  adjacentKey(keys, current, 1) ?? adjacentKey(keys, current, -1);

/** The parts of the chip on /approvals and /reviews (for a translated chip), or null when no workspace auto-approves. */
export function autoApproveChipParts(minStars: (4 | 5 | null)[]): { rule: "mixed" | "four" | "five"; count: number } | null {
  const on = minStars.filter((s): s is 4 | 5 => s !== null);
  if (on.length === 0) return null;
  return { rule: new Set(on).size > 1 ? "mixed" : on[0] === 4 ? "four" : "five", count: on.length };
}

/** The chip on /approvals and /reviews, or null when no workspace auto-approves. */
export function autoApproveChipText(minStars: (4 | 5 | null)[]): string | null {
  const parts = autoApproveChipParts(minStars);
  if (!parts) return null;
  const rule = { mixed: "4★ or 5★", four: "4★ and up", five: "5★" }[parts.rule];
  return `Auto-approve ${rule} is on in ${parts.count} ${parts.count === 1 ? "client" : "clients"}`;
}

const MAX_VALUE = 2000;
/** A profile field value (string, number, object such as hours or categories) as readable text. */
export function formatChangeValue(v: unknown, words: { notSet: string; empty: string } = { notSet: "Not set", empty: "Empty" }): string {
  if (v === null || v === undefined) return words.notSet;
  if (typeof v === "string") return v === "" ? words.empty : cut(String(plainValue(v)));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return cut(JSON.stringify(plainValue(v), null, 2));
}
const cut = (s: string) => (s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);

export function fieldLabel(field: string): string {
  return profileFieldLabel(field);
}

/** `2026-10-17 09:12` in the client's zone (`ws` is the row's workspace); "" for null. */
export const formatApprovalTime = (tf: TimeFormat, iso: string | null, ws?: string | null): string =>
  iso ? tf.dateTime(iso, ws) : "";

/** `5 m`, `2 h`, `3 d`. `now` is passed in so a server render and its hydration agree. */
export function ageParts(iso: string | null, now: number): { unit: "m" | "h" | "d"; n: number } | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return { unit: "m", n: mins };
  const hours = Math.floor(mins / 60);
  return hours < 24 ? { unit: "h", n: hours } : { unit: "d", n: Math.floor(hours / 24) };
}
export function ageLabel(iso: string | null, now: number): string {
  const a = ageParts(iso, now);
  return a ? `${a.n} ${a.unit}` : "";
}
