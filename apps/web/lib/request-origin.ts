import { customOriginFor, orgForHost } from "@opengmb/core";
import type { Db } from "@opengmb/db";
import { requestHost } from "./request-host";

/**
 * Origin to redirect to for a request: the custom origin when the request host belongs to an
 * organization, else BETTER_AUTH_URL (or the request's own URL when that is unset). Kept out of
 * request-host.ts because proxy.ts imports that file and has no database.
 */
export async function publicOriginOf(db: Db, request: Request): Promise<string> {
  const base = process.env.BETTER_AUTH_URL;
  const host = requestHost(request.headers);
  if (base && host && (await orgForHost(db, host, base))) return customOriginFor(host, base);
  return base ?? request.url;
}
