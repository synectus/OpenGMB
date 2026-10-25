import { and, eq } from "drizzle-orm";
import { locations, type Db, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { CoreError } from "../errors";
import type { Permission } from "../permissions";
import { clientFor } from "../reviews/reply-jobs";
import { MEDIA_LIMITS } from "../config/media-limits";

export type LocRow = typeof locations.$inferSelect;

/** A location of the actor's org inside their workspace scope, with `permission` checked on its workspace. */
export async function loadLocation(
  db: Db | Tx,
  actor: Actor,
  id: string,
  permission: Permission,
): Promise<LocRow> {
  const [loc] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  if (!loc || (scope !== "all" && !scope.includes(loc.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Location not found");
  }
  authorize(actor, permission, { workspaceId: loc.workspaceId });
  return loc;
}

/** The Google names of a linked location: `locations/{l}` and the v4 parent `accounts/{a}/locations/{l}`. */
export function googleNames(loc: LocRow): { locationName: string; parent: string } {
  if (!loc.googleLocationId || !loc.googleAccountName) {
    throw new CoreError("INVALID_INPUT", "Location is not linked to Google");
  }
  return {
    locationName: loc.googleLocationId,
    parent: `${loc.googleAccountName}/${loc.googleLocationId}`,
  };
}

/** For actions that enqueue a Google write: the location must be active and linked. */
export function requireWritable(loc: LocRow) {
  if (loc.status !== "active") {
    throw new CoreError("INVALID_INPUT", "Unknown or inactive location for this workspace");
  }
  if (!loc.connectionId) throw new CoreError("NOT_CONFIGURED", "Location has no Google connection");
  return googleNames(loc);
}

export async function clientForLocation(db: Db, actor: Actor, loc: LocRow) {
  googleNames(loc);
  const client = await clientFor(db, actor.orgId, loc.connectionId);
  if (!client) throw new CoreError("NOT_CONFIGURED", "Location has no Google connection");
  return client;
}

/**
 * Reasons a URL cannot be sent to Google as a photo source or place action link, or null. Only the
 * scheme and shape are checked: we never fetch the URL ourselves (no SSRF, no outbound call from
 * the app), Google fetches photo URLs. `imageHint` also checks a file extension, when there is one,
 * against the formats Google documents (JPG or PNG); URLs without an extension pass.
 */
export function httpsUrlProblem(
  raw: string,
  opts: { maxLength: number; imageHint?: boolean },
): string | null {
  if (raw.length > opts.maxLength) return `URL is longer than ${opts.maxLength} characters`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "https:") return "Only https URLs are accepted";
  if (u.username || u.password) return "URLs with credentials are not accepted";
  if (!u.hostname) return "URL has no host";
  if (opts.imageHint) {
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(u.pathname)?.[1]?.toLowerCase();
    if (ext && !(MEDIA_LIMITS.photo.formats as readonly string[]).includes(ext)) {
      return `Google accepts ${MEDIA_LIMITS.photo.formats.join("/").toUpperCase()} photos`;
    }
  }
  return null;
}

export function assertHttpsUrl(
  raw: string,
  opts: { maxLength: number; imageHint?: boolean },
): string {
  const problem = httpsUrlProblem(raw, opts);
  if (problem) throw new CoreError("INVALID_INPUT", problem);
  return raw;
}

/** Host only, for audit rows: a URL can carry a signed token in its path or query. */
export const hostOf = (raw: string) => {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
};
