/**
 * Default workspace time zone from a location's address, used when the first location is imported
 * (and by the 0036 migration backfill, which repeats this table in SQL: time/migration.test.ts
 * fails if they drift).
 *
 * Source: IANA tz database, zone1970.tab / zone.tab, https://data.iana.org/time-zones/tzdb/zone1970.tab
 * Verified on: 2026-10-19.
 *
 * A country with several zones takes its most populated one unless the state/territory says better.
 * US states with two zones use the zone that covers most of the state.
 */
export const COUNTRY_TIME_ZONE: Record<string, string> = {
  IN: "Asia/Kolkata",
  AU: "Australia/Sydney",
  US: "America/Chicago",
  GB: "Europe/London",
};

/** Australian states and territories (administrativeArea) that are not on Sydney time. */
export const AU_STATE_TIME_ZONE: Record<string, string> = {
  NSW: "Australia/Sydney",
  ACT: "Australia/Sydney",
  VIC: "Australia/Melbourne",
  TAS: "Australia/Hobart",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  NT: "Australia/Darwin",
  WA: "Australia/Perth",
};

export const US_STATE_TIME_ZONE: Record<string, string> = {
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", IN: "America/New_York", KY: "America/New_York", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/New_York", NH: "America/New_York",
  NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York", OH: "America/New_York",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  AZ: "America/Phoenix",
  CO: "America/Denver", ID: "America/Denver", MT: "America/Denver", NM: "America/Denver",
  UT: "America/Denver", WY: "America/Denver",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  AK: "America/Anchorage",
  HI: "Pacific/Honolulu",
};

/**
 * Default date format from the address country (decided 2026-10-19): day first in India,
 * Australia, the UK and New Zealand, month first in the US, ISO (YYYY-MM-DD) everywhere else.
 * The 0036 migration backfill repeats this table in SQL.
 */
export const COUNTRY_DATE_FORMAT: Record<string, "DD/MM/YYYY" | "MM/DD/YYYY"> = {
  IN: "DD/MM/YYYY",
  AU: "DD/MM/YYYY",
  GB: "DD/MM/YYYY",
  NZ: "DD/MM/YYYY",
  US: "MM/DD/YYYY",
};

/** Date formats a workspace can pick. The first is the default. */
export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Locale used only to get a short zone name ("IST"); en-US prints "GMT+5:30" for India. */
export const ZONE_LABEL_LOCALE: { prefix: string; locale: string }[] = [
  { prefix: "Asia/Kolkata", locale: "en-IN" },
  { prefix: "Asia/Calcutta", locale: "en-IN" },
  { prefix: "Australia/", locale: "en-AU" },
  { prefix: "Europe/London", locale: "en-GB" },
];
