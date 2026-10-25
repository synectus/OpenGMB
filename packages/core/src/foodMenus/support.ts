import { GoogleApiError } from "../google/errors";

/**
 * True when Google's answer to getFoodMenus means "this location cannot have a food menu" (a clinic,
 * a shop ...): HTTP 400 (FAILED_PRECONDITION / INVALID_ARGUMENT) or 404 (NOT_FOUND). The resource
 * name is built by us from the location's own ids, so these statuses are about the location, not a
 * malformed request. Any other failure (401, 403, 429, 5xx) is a real error and is not mapped.
 * To confirm against live: the exact status Google returns for a non-restaurant is still to check.
 */
export function isFoodMenuUnsupported(e: unknown): boolean {
  return e instanceof GoogleApiError && (e.status === 400 || e.status === 404);
}
