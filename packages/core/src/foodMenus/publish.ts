import type { GoogleFoodMenu, GoogleFoodMenus } from "../google/client";
import type { ThrottledGoogleClient } from "../google/throttled-client";
import { CoreError } from "../errors";
import { foodMenusSchema } from "./schema";

/**
 * The ONLY place outside the Google client implementations that calls `.updateFoodMenus(`
 * (`reply-enforcement.test.ts` fails on any other call site). The write goes through the throttled
 * client (per-location edit bucket, idempotency key `foodmenu:<opId>`) and, in live mode while
 * writes are off, through the read-only wrapper, which refuses it. Always a full replace of
 * `menus` (updateMask "menus"): Google cannot update items of a repeated field one by one.
 */
export type FoodMenuWriter = Pick<ThrottledGoogleClient, "updateFoodMenus">;

export const foodMenuKey = (opId: string) => `foodmenu:${opId}`;

export function publishFoodMenus(
  client: FoodMenuWriter,
  where: { orgId: string; opId: string; parent: string },
  menus: unknown,
): Promise<GoogleFoodMenus> {
  const parsed = foodMenusSchema.safeParse(menus);
  if (!parsed.success) throw new CoreError("INVALID_INPUT", "Food menu failed validation");
  return client.updateFoodMenus(
    { name: `${where.parent}/foodMenus`, menus: parsed.data as GoogleFoodMenu[] },
    ["menus"],
    { orgId: where.orgId, idempotencyKey: foodMenuKey(where.opId) },
  );
}
