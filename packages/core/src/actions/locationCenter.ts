import { eq } from "drizzle-orm";
import { z } from "zod";
import { locations } from "@opengmb/db";
import { loadLocation, type LocRow } from "../locationOps/access";
import { tryEnqueueLocationCenter } from "../locations/center";
import { defineAction } from "../registry";

const centerOut = z.object({
  locationId: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  /** google, places, dataforseo, tracker or manual; null when no source has placed the location yet. */
  source: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const shape = (l: LocRow) => ({
  locationId: l.id,
  lat: l.centerLat,
  lng: l.centerLng,
  source: l.centerSource,
  updatedAt: l.centerUpdatedAt?.toISOString() ?? null,
});

export const locationsCenterGet = defineAction({
  name: "locations.center.get",
  description:
    "The map position stored for one location: latitude, longitude and where it came from (google, places, dataforseo, tracker, or manual when someone set it by hand). lat, lng and source are null until a source has placed the location. Read only. Needs location:read.",
  input: z.object({ locationId: z.uuid() }),
  output: centerOut,
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    return shape(await loadLocation(tx, actor, input.locationId, "location:read"));
  },
});

export const locationsCenterSet = defineAction({
  name: "locations.center.set",
  description:
    "Set a location's map position by hand (latitude -90 to 90, longitude -180 to 180). The position is marked manual and automatic lookups never replace it, even when the address changes, until locations.center.clearManual. Does not write to Google. Needs workspace:manage (owner, admin).",
  input: z.object({ locationId: z.uuid(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  output: centerOut,
  permission: "workspace:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "workspace:manage");
    // The address hash is left as it is: the nightly watch skips a manual centre either way.
    const [l] = await tx
      .update(locations)
      .set({ centerLat: input.lat, centerLng: input.lng, centerSource: "manual", centerUpdatedAt: new Date() })
      .where(eq(locations.id, loc.id))
      .returning();
    await audit({
      action: "location.center_set_manual",
      entityType: "location",
      entityId: loc.id,
      before: { lat: loc.centerLat, lng: loc.centerLng, source: loc.centerSource },
      after: { lat: input.lat, lng: input.lng, source: "manual" },
    });
    return shape(l!);
  },
});

export const locationsCenterClearManual = defineAction({
  name: "locations.center.clearManual",
  description:
    "Go back to automatic map positions: removes a hand-set position and queues a new lookup (Google, Places, DataForSEO, then the rank tracker). Does nothing when the position is not manual. Does not write to Google. Needs workspace:manage (owner, admin).",
  input: z.object({ locationId: z.uuid() }),
  output: centerOut,
  permission: "workspace:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "workspace:manage");
    if (loc.centerSource !== "manual") {
      await audit({ action: "location.center_clear_unchanged", entityType: "location", entityId: loc.id, before: { source: loc.centerSource }, after: { source: loc.centerSource } });
      return shape(loc);
    }
    // The hash goes too: with the old one the lookup would find "coordinates for this address" and stop.
    const [l] = await tx
      .update(locations)
      .set({ centerLat: null, centerLng: null, centerSource: null, centerAddressHash: null, centerUpdatedAt: null })
      .where(eq(locations.id, loc.id))
      .returning();
    await tryEnqueueLocationCenter(tx, { locationId: loc.id, reason: "address_changed" });
    await audit({
      action: "location.center_cleared_manual",
      entityType: "location",
      entityId: loc.id,
      before: { lat: loc.centerLat, lng: loc.centerLng, source: "manual" },
      after: { source: null },
    });
    return shape(l!);
  },
});
