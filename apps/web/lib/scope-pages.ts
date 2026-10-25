// apps/web/lib/scope-pages.ts
// What each scope-aware page does with the scope (U5). Pure, so the rules have unit tests.
import type { Scope } from "./scope";

/** The most locationIds performance.* takes in one call. */
export const PERFORMANCE_MAX_LOCATIONS = 200;

/** Location ids a group or location scope narrows a list to; undefined for All clients and a whole client. */
export const narrowLocationIds = (s: Scope): string[] | undefined =>
  s.kind === "group" || s.kind === "location" ? s.locationIds : undefined;

/**
 * How an action that takes `locationIds` or `groupId` is narrowed to a group or location scope: a group
 * by its id (the server resolves its members, so a group of any size works), a location by its one id.
 */
export const narrowArgs = (s: Scope): { groupId?: string; locationIds?: string[] } =>
  s.kind === "group" ? { groupId: s.groupId! } : s.kind === "location" ? { locationIds: [s.locationId!] } : {};

export type PerformanceTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "locations"; locationIds: string[] }
  /** All clients with more locations than one call takes: ask for a client. */
  | { kind: "pick" }
  /** A group (or All clients) with no active location. */
  | { kind: "empty" };

/**
 * What Performance reads. A client or the only client: by workspace. A location or group: its
 * locations. All clients with several: every active location across clients, when one call can take them.
 */
export function performanceTarget(s: Scope): PerformanceTarget {
  if (s.kind === "location") return { kind: "locations", locationIds: [s.locationId!] };
  if (s.kind === "group") {
    return s.locationIds.length === 0
      ? { kind: "empty" }
      : { kind: "locations", locationIds: s.locationIds.slice(0, PERFORMANCE_MAX_LOCATIONS) };
  }
  if (s.onlyWorkspaceId) return { kind: "workspace", workspaceId: s.onlyWorkspaceId };
  if (s.locationIds.length === 0) return { kind: "empty" };
  return s.locationIds.length <= PERFORMANCE_MAX_LOCATIONS ? { kind: "locations", locationIds: s.locationIds } : { kind: "pick" };
}

/** The one location "Refresh from Google" refreshes: the scope holds exactly one active location. */
export const refreshLocationId = (s: Scope): string | null => (s.locationIds.length === 1 ? s.locationIds[0]! : null);

/** A group scope already names the group, so the Group facet on Alerts would only contradict it. */
export const showGroupFacet = (s: Scope): boolean => s.kind !== "group";

/** Where a new report starts: the scope's client, group or location. All clients with several clients leaves the first client to be changed. */
export function reportStart(
  s: Scope,
  workspaceIds: string[],
): { workspaceId: string; scope: "workspace" | "group" | "locations"; groupId: string; locationIds: string[] } {
  const workspaceId = workspaceIds.find((id) => id === s.onlyWorkspaceId) ?? workspaceIds[0] ?? "";
  if (s.kind === "group") return { workspaceId, scope: "group", groupId: s.groupId!, locationIds: [] };
  if (s.kind === "location") return { workspaceId, scope: "locations", groupId: "", locationIds: [s.locationId!] };
  return { workspaceId, scope: "workspace", groupId: "", locationIds: [] };
}
