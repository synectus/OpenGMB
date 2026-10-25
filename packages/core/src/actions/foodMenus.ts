import { z } from "zod";
import { locationWriteOps } from "@opengmb/db";
import { enqueueJob } from "../jobs";
import {
  clientForLocation,
  googleNames,
  loadLocation,
  requireWritable,
} from "../locationOps/access";
import { LOCATION_OP_QUEUE } from "../locationOps/jobs";
import { foodMenusSchema } from "../foodMenus/schema";
import { isFoodMenuUnsupported } from "../foodMenus/support";
import { defineAction } from "../registry";
import { opOut, recentOps, toOpOut } from "./media";

const menusOut = z.array(z.record(z.string(), z.unknown()));

export const foodMenusGet = defineAction({
  name: "foodMenus.get",
  description:
    "Read a location's food menus live from Google (v4 getFoodMenus), outside any transaction, plus the most recent food menu saves queued from here (status pending, applied, failed with a reason code). menus is the list Google returns: each menu has labels, sections (labels, items) and cuisines; each item has labels, attributes (price, spiciness, allergen, dietaryRestriction, ...) and optional options. Only restaurants and similar locations have a food menu; supported is false (menus empty) when Google says the location cannot have a food menu, such as a clinic; call this only when a menu is wanted, since it spends a Google call.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({ supported: z.boolean(), menus: menusOut, operations: z.array(opOut) }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    const { parent } = googleNames(loc);
    const operations = await recentOps(db, loc.id, "food_menu");
    try {
      const res = await client.getFoodMenus(`${parent}/foodMenus`);
      return { supported: true, menus: res.menus as unknown as Record<string, unknown>[], operations };
    } catch (e) {
      if (isFoodMenuUnsupported(e)) return { supported: false, menus: [], operations };
      throw e;
    }
  },
});

export const foodMenusUpdate = defineAction({
  name: "foodMenus.update",
  description:
    "Replace a location's whole food menu. Pass the complete list, starting from foodMenus.get: anything left out is removed at Google, and fields this tool does not edit (nutritionFacts, ingredients, cuisines ...) must be passed back unchanged. Each menu needs labels (displayName up to 140 characters, description up to 1000) and at least one section; each section labels and at least one item; each item labels and attributes.price {currencyCode, units, nanos}. Asynchronous: records the operation and queues a worker job (status pending); nothing is sent to Google inside this call, and nothing at all while Google writes are off. Needs profile:edit.",
  input: z.object({ locationId: z.uuid(), menus: foodMenusSchema }),
  output: z.object({ operation: opOut }),
  permission: "profile:edit",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const loc = await loadLocation(tx, actor, input.locationId, "profile:edit");
    requireWritable(loc);
    const sections = input.menus.reduce((n, m) => n + m.sections.length, 0);
    const items = input.menus.reduce(
      (n, m) => n + m.sections.reduce((k, s) => k + s.items.length, 0),
      0,
    );
    const [op] = await tx
      .insert(locationWriteOps)
      .values({
        orgId: actor.orgId,
        locationId: loc.id,
        domain: "food_menu",
        kind: "update",
        payload: { menus: input.menus },
        requestedBy: actor.userId,
      })
      .returning();
    await enqueueJob(tx, LOCATION_OP_QUEUE, { opId: op!.id });
    await audit({
      action: "food_menu.update_requested",
      entityType: "location_write_op",
      entityId: op!.id,
      after: {
        locationId: loc.id,
        menus: input.menus.length,
        sections,
        items,
        status: "pending",
      },
    });
    return { operation: toOpOut(op!) };
  },
});
