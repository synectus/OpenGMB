import { eq } from "drizzle-orm";
import { z } from "zod";
import { locationAutoRevert, type Tx } from "@opengmb/db";
import { loadLocation } from "../locationOps/access";
import { defineAction } from "../registry";

const settingsOut = z.object({
  locationId: z.string(),
  name: z.boolean(),
  phone: z.boolean(),
  address: z.boolean(),
});

async function read(tx: Tx, locationId: string): Promise<z.input<typeof settingsOut>> {
  const [r] = await tx
    .select()
    .from(locationAutoRevert)
    .where(eq(locationAutoRevert.locationId, locationId));
  return { locationId, name: r?.name ?? false, phone: r?.phone ?? false, address: r?.address ?? false };
}

export const profileAutoRevertGet = defineAction({
  name: "profile.autoRevert.get",
  description:
    "Which outside edits a location undoes automatically (L8): name, phone, address. All off by default.",
  input: z.object({ locationId: z.uuid() }),
  output: settingsOut,
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "location:read");
    return read(tx, loc.id);
  },
});

export const profileAutoRevertSet = defineAction({
  name: "profile.autoRevert.set",
  description:
    "Turn automatic undo of outside edits on or off for one location; only the switches you pass change. name = the business name, phone = the phone numbers, address = the storefront address. When the nightly profile watch finds an outside change to an enabled field it files the usual change alert, then restores the previous value through the same change set, approval and apply path as profile.changes.revert, audited as an automatic revert and attributed to the person who saved this setting (their approval stands in). A field is reverted at most once per 24 hours; changes Google suggests, suspended or unverified locations and fields that are switched off are never reverted. Needs review:configure (owner, admin).",
  input: z.object({
    locationId: z.uuid(),
    name: z.boolean().optional(),
    phone: z.boolean().optional(),
    address: z.boolean().optional(),
  }),
  output: settingsOut,
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "review:configure");
    const before = await read(tx, loc.id);
    const next = {
      name: input.name ?? before.name,
      phone: input.phone ?? before.phone,
      address: input.address ?? before.address,
    };
    const values = { ...next, enabledBy: actor.userId, updatedAt: new Date() };
    await tx
      .insert(locationAutoRevert)
      .values({ locationId: loc.id, orgId: actor.orgId, ...values })
      .onConflictDoUpdate({ target: locationAutoRevert.locationId, set: values });
    await audit({
      action: "location.auto_revert_set",
      entityType: "location",
      entityId: loc.id,
      before: { name: before.name, phone: before.phone, address: before.address },
      after: next,
    });
    return { locationId: loc.id, ...next };
  },
});
