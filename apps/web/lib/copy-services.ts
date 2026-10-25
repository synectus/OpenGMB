// Pure logic for "Copy to locations" in the Services manager. Client-safe.
import { OTHER, type ServiceGroup, type ServiceRow } from "./services-manager";
import type { ServiceItem } from "./profile-editor";

/** Core's cap on a location's services (Google documents none). */
export const SERVICE_CAP = 300;

export type CopyItem = { item: ServiceItem; name: string };

/** One service as an `addServiceItems` entry, description and price carried; null while an own service has no name. */
export function itemForRow(row: ServiceRow): CopyItem | null {
  if (row.kind === "google") {
    if (!row.selected) return null;
    return {
      name: row.name,
      item: {
        structuredServiceItem: {
          serviceTypeId: row.id,
          ...(row.description ? { description: row.description } : {}),
        },
        ...(row.price ? { price: row.price } : {}),
      },
    };
  }
  const name = row.name.trim();
  if (!name) return null;
  return {
    name,
    item: {
      freeFormServiceItem: {
        category: row.category,
        label: { displayName: name, ...(row.description ? { description: row.description } : {}) },
      },
      ...(row.price ? { price: row.price } : {}),
    },
  };
}

/** A category's services on the profile. The "Other" group mixes categories, so it cannot be copied as one. */
export function itemsForGroup(g: ServiceGroup): CopyItem[] {
  if (g.key === OTHER) return [];
  return g.rows.flatMap((r) => itemForRow(r) ?? []);
}

export type ServiceAddLike = {
  send: number[];
  alreadyThere: number[];
  skipped: { index: number; reason: string }[];
};

const REASON: Record<string, string> = {
  category_not_on_location: "its category is not one of this location's categories",
  type_not_offered: "Google does not list it for this location's categories",
  type_unverified: "Google's list for this location could not be checked",
  over_cap: `the list would pass ${SERVICE_CAP} services`,
};

/** What copying does at one location, in words. Null while the preview has no service plan for it. */
export function copyNotes(names: string[], add: ServiceAddLike | null | undefined) {
  if (!add) return null;
  const flags = add.skipped.map(
    (s) => `${names[s.index] ?? "Service"}: not sent, ${REASON[s.reason] ?? s.reason}`,
  );
  const unchanged =
    add.alreadyThere.length > 0
      ? `${add.alreadyThere.length} already there, left as they are (an existing service keeps its own price and description)`
      : null;
  return { added: add.send.length, unchanged, flags };
}

/** "3 will be added, 2 not sent" across all targets. */
export function copySummary(rows: { added: number; flags: string[] }[]): string {
  const added = rows.reduce((n, r) => n + r.added, 0);
  const skipped = rows.reduce((n, r) => n + r.flags.length, 0);
  return `${added} ${added === 1 ? "service" : "services"} will be added${skipped ? `, ${skipped} not sent` : ""}`;
}

/** The preview's per-location send lists, echoed to propose (it can only remove from the additions). */
export const sendLists = (p: { locationId: string; serviceAdd?: ServiceAddLike | null }[]) =>
  p.flatMap((l) => (l.serviceAdd ? [{ locationId: l.locationId, indexes: l.serviceAdd.send }] : []));
