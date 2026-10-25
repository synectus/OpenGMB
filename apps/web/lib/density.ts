import "server-only";
import { cookies } from "next/headers";
import { DENSITY_COOKIE, defaultDensity, parseDensity, type Density } from "./preferences";
import { currentScope } from "./scope-server";

/**
 * The density in force: the cookie if set, else the default for the active locations in the
 * current scope (1 to 3 Comfortable, otherwise Compact). Used by the app shell and by the Account
 * page's Display section, so the two always agree.
 */
export async function currentDensity(): Promise<Density> {
  const set = parseDensity((await cookies()).get(DENSITY_COOKIE)?.value);
  if (set) return set;
  return defaultDensity((await currentScope()).activeLocations);
}
