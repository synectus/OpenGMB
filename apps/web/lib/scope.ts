// apps/web/lib/scope.ts
// Pure logic for the top-bar scope switcher (canvas 0, ShellOverlays). Client-safe: the cookie and
// the list actions live in lib/scope-server.ts.

import type { DateFormat } from "@opengmb/core/time";

export const SCOPE_COOKIE = "syngmb_scope";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScopeKey = { kind: "all" } | { kind: "w" | "g" | "l"; id: string };

/** The cookie value: "all", "w:<uuid>", "g:<uuid>" or "l:<uuid>". Anything else is null. */
export function parseScope(v: string | null | undefined): ScopeKey | null {
  if (v === "all") return { kind: "all" };
  const m = v?.match(/^([wgl]):(.+)$/);
  if (!m || !UUID.test(m[2]!)) return null;
  return { kind: m[1] as "w" | "g" | "l", id: m[2]!.toLowerCase() };
}

export const formatScope = (k: ScopeKey) => (k.kind === "all" ? "all" : `${k.kind}:${k.id}`);

/** What the user can see, from workspaces.list, locationGroups.list and locations.list. */
export type ScopeData = {
  workspaces: { id: string; name: string; timeZone?: string; dateFormat?: DateFormat }[];
  groups: { id: string; workspaceId: string; name: string; locationIds: string[] }[];
  locations: { id: string; workspaceId: string; name: string; title: string | null; status: string; addressSummary?: string | null; phone?: string | null }[];
};

export type Scope = {
  /** The cookie form of this scope. */
  value: string;
  kind: "all" | "workspace" | "group" | "location";
  label: string;
  /** Top-bar meta: "4 clients · 18 locations", "6 locations", or a location's workspace. */
  meta: string;
  /** Set for workspace, group and location scopes (the workspace they belong to). */
  workspaceId: string | null;
  workspaceName: string | null;
  groupId: string | null;
  locationId: string | null;
  /** The workspace a one-workspace page works in: the scope's, or the org's only one under All clients. */
  onlyWorkspaceId: string | null;
  /** Active locations in scope. */
  locationIds: string[];
  activeLocations: number;
  source: "url" | "cookie" | "default";
  /** The ?ws= value to carry in this page's own links (only when the URL chose the scope). */
  urlWs: string | undefined;
};
type Resolved = Omit<Scope, "source" | "urlWs">;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function build(data: ScopeData, key: ScopeKey | null): Resolved | null {
  if (!key) return null;
  const active = data.locations.filter((l) => l.status === "active");
  const names = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const of = (ids: string[], r: Omit<Resolved, "locationIds" | "activeLocations">): Resolved => ({
    ...r,
    locationIds: ids,
    activeLocations: ids.length,
  });
  if (key.kind === "all") {
    return of(
      active.map((l) => l.id),
      {
        value: "all",
        kind: "all",
        label: "All clients",
        meta: `${plural(data.workspaces.length, "client")} · ${plural(active.length, "location")}`,
        workspaceId: null,
        workspaceName: null,
        groupId: null,
        locationId: null,
        onlyWorkspaceId: data.workspaces.length === 1 ? data.workspaces[0]!.id : null,
      },
    );
  }
  if (key.kind === "w") {
    const name = names.get(key.id);
    if (name === undefined) return null;
    const ids = active.filter((l) => l.workspaceId === key.id).map((l) => l.id);
    return of(ids, {
      value: `w:${key.id}`,
      kind: "workspace",
      label: name,
      meta: plural(ids.length, "location"),
      workspaceId: key.id,
      workspaceName: name,
      groupId: null,
      locationId: null,
      onlyWorkspaceId: key.id,
    });
  }
  if (key.kind === "g") {
    const g = data.groups.find((x) => x.id === key.id);
    const name = g ? names.get(g.workspaceId) : undefined;
    if (!g || name === undefined) return null;
    const ids = active.filter((l) => g.locationIds.includes(l.id)).map((l) => l.id);
    return of(ids, {
      value: `g:${g.id}`,
      kind: "group",
      label: `Group: ${g.name}`,
      meta: plural(ids.length, "location"),
      workspaceId: g.workspaceId,
      workspaceName: name,
      groupId: g.id,
      locationId: null,
      onlyWorkspaceId: g.workspaceId,
    });
  }
  const l = active.find((x) => x.id === key.id);
  const name = l ? names.get(l.workspaceId) : undefined;
  if (!l || name === undefined) return null;
  return of([l.id], {
    value: `l:${l.id}`,
    kind: "location",
    label: l.title ?? l.name,
    meta: name,
    workspaceId: l.workspaceId,
    workspaceName: name,
    groupId: null,
    locationId: l.id,
    onlyWorkspaceId: l.workspaceId,
  });
}

/** A URL value: a bare workspace uuid (every existing ?ws= link), or any cookie form ("all", "w:", "g:", "l:"). */
function urlKey(v: string | null | undefined): ScopeKey | null {
  const url = v?.trim().toLowerCase();
  return url && UUID.test(url) ? { kind: "w", id: url } : parseScope(url);
}

/** URL ?ws= first, then the cookie, then All clients. Each is checked against what the user can see. */
export function resolveScope(
  data: ScopeData,
  given: { url?: string | null; cookie?: string | null },
): Scope {
  const fromUrl = build(data, urlKey(given.url));
  if (fromUrl) return { ...fromUrl, source: "url", urlWs: given.url!.trim().toLowerCase() };
  const fromCookie = build(data, parseScope(given.cookie));
  if (fromCookie) return { ...fromCookie, source: "cookie", urlWs: undefined };
  return { ...build(data, { kind: "all" })!, source: "default", urlWs: undefined };
}

export type ScopeOption = {
  value: string;
  label: string;
  /** Shown in the list. */
  meta: string;
  /** Shown in the top-bar trigger when this option is current. */
  trigger: string;
  depth: 0 | 1 | 2;
  /** A location's address (else phone), to tell same-named locations apart. Also part of `search`. */
  detail?: string;
  /** cmdk filter text; unique per option. */
  search: string;
};

/** One option by its cookie value; null when the value names nothing the user can see. */
export function scopeOptionFor(data: ScopeData, value: string): ScopeOption | null {
  const key = parseScope(value);
  const s = build(data, key);
  if (!s || !key) return null;
  if (key.kind === "all") {
    return { value: "all", label: s.label, meta: plural(s.activeLocations, "location"), trigger: s.meta, depth: 0, search: "all clients" };
  }
  if (key.kind === "w") {
    return { value: s.value, label: s.label, meta: s.meta, trigger: s.meta, depth: 1, search: `${s.label} ${s.value}` };
  }
  const w = s.workspaceName!;
  if (key.kind === "g") {
    return { value: s.value, label: s.label, meta: s.meta, trigger: s.meta, depth: 2, search: `${s.label} ${w} ${s.value}` };
  }
  const loc = data.locations.find((x) => x.id === key.id);
  const detail = loc?.addressSummary?.trim() || loc?.phone?.trim() || undefined;
  return {
    value: s.value,
    label: s.label,
    meta: "location",
    trigger: w,
    depth: 2,
    ...(detail ? { detail } : {}),
    search: `${s.label} ${w}${detail ? ` ${detail}` : ""} ${s.value}`,
  };
}

/** All clients, then each workspace followed by its groups and active locations (list order). */
export function scopeOptions(data: ScopeData): ScopeOption[] {
  const out: ScopeOption[] = [scopeOptionFor(data, "all")!];
  for (const w of data.workspaces) {
    out.push(scopeOptionFor(data, `w:${w.id}`)!);
    for (const g of data.groups.filter((x) => x.workspaceId === w.id)) out.push(scopeOptionFor(data, `g:${g.id}`)!);
    for (const l of data.locations.filter((x) => x.workspaceId === w.id && x.status === "active")) {
      out.push(scopeOptionFor(data, `l:${l.id}`)!);
    }
  }
  return out;
}

/** Up to this many options travel with every page; a longer list is fetched when the switcher opens (H4). */
export const SCOPE_EMBED_MAX = 50;
/** Options per fetched page. */
export const SCOPE_PAGE_SIZE = 50;

/**
 * What the shell sends to the browser. A short list (a few clients) goes whole, as before. A long one
 * sends only All clients and the first clients, plus the current option for the trigger; groups and
 * locations are searched and paged by `searchScopeOptions` when the list opens, so the page does not
 * carry one entry per location (about 120 KB at 500 locations, on every page).
 */
export function shellScopeOptions(data: ScopeData, currentValue: string): { options: ScopeOption[]; complete: boolean; current: ScopeOption } {
  // All clients plus one entry per client, group and location (at most): shorter than the limit means whole.
  const small = data.workspaces.length + data.groups.length + data.locations.length < SCOPE_EMBED_MAX;
  const full = small ? scopeOptions(data) : null;
  const current = (full ?? []).find((o) => o.value === currentValue) ?? scopeOptionFor(data, currentValue) ?? scopeOptionFor(data, "all")!;
  if (full) return { options: full, complete: true, current };
  const top = [scopeOptionFor(data, "all")!, ...data.workspaces.slice(0, SCOPE_PAGE_SIZE).map((w) => scopeOptionFor(data, `w:${w.id}`)!)];
  return { options: top, complete: false, current };
}

/** The options whose text holds every word of `query`, one page from `offset`; `more` says another page follows. */
export function searchScopeOptions(data: ScopeData, query: string, offset: number): { options: ScopeOption[]; more: boolean } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = scopeOptions(data).filter((o) => {
    const text = `${o.label} ${o.search}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return { options: hits.slice(offset, offset + SCOPE_PAGE_SIZE), more: hits.length > offset + SCOPE_PAGE_SIZE };
}

/** The cookie form of a ?ws= value, or null when it names no scope. */
export function urlScopeValue(urlWs: string | null | undefined): string | null {
  const key = urlKey(urlWs);
  return key ? formatScope(key) : null;
}

/** What the trigger shows: a known ?ws= from the URL, else the server's (cookie) scope. */
export function displayedScope(options: ScopeOption[], urlWs: string | null, serverValue: string): string {
  const key = urlKey(urlWs);
  const value = key && formatScope(key);
  return value && options.some((o) => o.value === value) ? value : serverValue;
}

const KEEP = new Set(["view", "tab", "status", "from", "to", "kpi", "month", "replied", "rating"]);

/** Same page after a scope change, keeping only params that do not name a thing (Decisions 5). */
export function afterScopeChangeHref(pathname: string, search: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) if (KEEP.has(k)) p.append(k, v);
  const qs = p.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** The narrowest list filter for actions that take workspaceId, groupId or locationIds. */
export function scopeFilter(s: Scope): { workspaceId?: string; groupId?: string; locationIds?: string[] } {
  if (s.kind === "workspace") return { workspaceId: s.workspaceId! };
  if (s.kind === "group") return { groupId: s.groupId! };
  if (s.kind === "location") return { locationIds: [s.locationId!] };
  return {};
}

/** Workspaces the auto-approve chip speaks for. */
export const autoApproveIds = (s: Scope, workspaces: { id: string }[]) =>
  s.workspaceId ? [s.workspaceId] : workspaces.map((w) => w.id);

/** For pages whose actions filter by workspace only: say that a group or location shows the whole client. */
export function narrowNote(s: Scope, what: string): string | null {
  if (s.kind !== "group" && s.kind !== "location") return null;
  return `Showing all of ${s.workspaceName}. ${what} cannot be narrowed to a group or location yet.`;
}
