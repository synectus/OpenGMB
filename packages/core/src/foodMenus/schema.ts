import { z } from "zod";
import { FOOD_MENU_LIMITS } from "../config/media-limits";

/**
 * The v4 `FoodMenus.menus` shape (https://developers.google.com/my-business/reference/rest/v4/FoodMenus).
 * Every object is `loose()`: updateFoodMenus replaces the whole `menus` list, so a field this editor
 * does not know (nutritionFacts, ingredients, portionSize, cuisines, ...) must travel unchanged
 * from the read to the write or the save would silently delete it.
 */
const label = z
  .object({
    displayName: z.string().trim().min(1).max(FOOD_MENU_LIMITS.displayNameMax),
    description: z.string().max(FOOD_MENU_LIMITS.descriptionMax).optional(),
    languageCode: z.string().max(35).optional(),
  })
  .loose();
const labels = z.array(label).min(1);

const money = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    units: z.string().regex(/^-?\d{1,15}$/).optional(),
    nanos: z.number().int().min(0).max(999_999_999).optional(),
  })
  .loose();

const attributes = z
  .object({
    price: money,
    spiciness: z.enum(FOOD_MENU_LIMITS.spiciness).optional(),
    allergen: z.array(z.enum(FOOD_MENU_LIMITS.allergens)).optional(),
    dietaryRestriction: z.array(z.enum(FOOD_MENU_LIMITS.dietary)).optional(),
  })
  .loose();

const option = z.object({ labels, attributes }).loose();
const item = z.object({ labels, attributes, options: z.array(option).optional() }).loose();
const section = z.object({ labels, items: z.array(item).min(1) }).loose();
export const foodMenuSchema = z
  .object({
    labels,
    sourceUrl: z.string().max(2000).optional(),
    sections: z.array(section).min(1),
    cuisines: z.array(z.string()).optional(),
  })
  .loose();
export const foodMenusSchema = z.array(foodMenuSchema).max(FOOD_MENU_LIMITS.menusMax);

export type FoodMenuInput = z.infer<typeof foodMenuSchema>;
