import { and, eq, isNull, or } from "drizzle-orm";
import { locations, memberships, type Tx } from "@opengmb/db";
import { roleHasPermission } from "./permissions";

export const GOOGLE_NOTIFICATION_KINDS = {
  NEW_REVIEW: "google.new_review",
  UPDATED_REVIEW: "google.updated_review",
  GOOGLE_UPDATE: "google.google_update",
} as const;
export type GoogleNotificationType = keyof typeof GOOGLE_NOTIFICATION_KINDS;

/**
 * Kind and title for a Google notification. The title is built from the type and the location
 * NAME only: review text can contain patient details and must never reach a notification.
 */
export function googleNotificationContent(type: GoogleNotificationType, locationName: string) {
  const title = {
    NEW_REVIEW: `New review at ${locationName}`,
    UPDATED_REVIEW: `Updated review at ${locationName}`,
    GOOGLE_UPDATE: `Google suggested an edit to ${locationName}`,
  }[type];
  return { kind: GOOGLE_NOTIFICATION_KINDS[type], title };
}

/**
 * User ids who should hear about something at a location: members of the location's org whose
 * role has location:read and whose membership covers the location's workspace (org-wide
 * memberships cover every workspace; client memberships only their own). Same rule as
 * authorize() + workspaceScope(), evaluated per membership because there is no acting user here.
 */
export async function recipientsForLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<string[]> {
  const [loc] = await tx
    .select({ workspaceId: locations.workspaceId })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.orgId, orgId)));
  if (!loc) return [];
  const rows = await tx
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        or(isNull(memberships.workspaceId), eq(memberships.workspaceId, loc.workspaceId)),
      ),
    );
  return [
    ...new Set(rows.filter((r) => roleHasPermission(r.role, "location:read")).map((r) => r.userId)),
  ].sort();
}
