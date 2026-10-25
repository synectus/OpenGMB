import { AU_STATE_TIME_ZONE, COUNTRY_DATE_FORMAT, COUNTRY_TIME_ZONE, US_STATE_TIME_ZONE } from "../config/time-zones";

/** Zones the runtime knows, plus UTC and Asia/Kolkata (supportedValuesOf lists neither; it has Asia/Calcutta). */
const EXTRA = ["UTC", "Asia/Kolkata"];
const supported = (): string[] => Intl.supportedValuesOf("timeZone");

let list: string[] | null = null;
/** For a picker: sorted, Asia/Calcutta replaced by Asia/Kolkata. */
export function timeZoneList(): string[] {
  list ??= [...new Set([...supported(), ...EXTRA])].filter((z) => z !== "Asia/Calcutta").sort();
  return list;
}

let valid: Set<string> | null = null;
export function isValidTimeZone(z: string): boolean {
  valid ??= new Set([...supported(), ...EXTRA]);
  return valid.has(z);
}

/**
 * The default zone for an address, or null when nothing is known. `region` is the ISO country code
 * (storefrontAddress.regionCode), `area` the state (administrativeArea).
 */
export function zoneForAddress(region: string | null | undefined, area?: string | null): string | null {
  const c = region?.trim().toUpperCase();
  if (!c) return null;
  const a = area?.trim().toUpperCase();
  if (c === "US" && a && US_STATE_TIME_ZONE[a]) return US_STATE_TIME_ZONE[a]!;
  if (c === "AU" && a && AU_STATE_TIME_ZONE[a]) return AU_STATE_TIME_ZONE[a]!;
  return COUNTRY_TIME_ZONE[c] ?? null;
}

/** The default date format for an address country, or null when the country has none (keep YYYY-MM-DD). */
export function dateFormatForAddress(region: string | null | undefined) {
  const c = region?.trim().toUpperCase();
  return (c && COUNTRY_DATE_FORMAT[c]) || null;
}
