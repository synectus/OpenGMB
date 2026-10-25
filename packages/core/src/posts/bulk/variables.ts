/** Per-location values a bulk post can use as {name}, {city} ...; null = we have no stored value. */
export const BULK_VARIABLES = ["name", "city", "phone", "address", "website"] as const;
export type BulkVariable = (typeof BULK_VARIABLES)[number];
export type LocationVars = Record<BulkVariable, string | null>;

const TOKEN = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
const known = (k: string): k is BulkVariable => (BULK_VARIABLES as readonly string[]).includes(k);

/**
 * Replace {variable} in `text` with this location's value. An unknown variable, or one with no
 * value, is an error (the text keeps the token): a post must never go out with a blank where the
 * city should be.
 */
export function resolveVariables(
  text: string,
  vars: LocationVars,
): { text: string; errors: string[] } {
  const errors = new Set<string>();
  const out = text.replace(TOKEN, (token, raw: string) => {
    const key = raw.toLowerCase();
    if (!known(key)) {
      errors.add(`Unknown variable ${token}. Use ${BULK_VARIABLES.map((v) => `{${v}}`).join(", ")}`);
      return token;
    }
    const value = vars[key]?.trim();
    if (!value) {
      errors.add(`{${key}} has no value for ${vars.name ?? "this location"}`);
      return token;
    }
    return value;
  });
  return { text: out, errors: [...errors] };
}

/**
 * The city out of locations.address_summary, which is built as: street lines, locality,
 * "state postcode", region code (see locations/google.ts addressSummary). Returns null when the
 * shape is not recognisable, so a missing city is an error and never a guess.
 */
export function cityFromAddress(summary: string | null): string | null {
  if (!summary) return null;
  const parts = summary.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && /^[A-Z]{2}$/.test(parts[parts.length - 1]!) && parts.length > 1) parts.pop();
  // "TX 78701", "NSW 2000", or a bare postcode / state code.
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !last || !/^([A-Za-z]{2,3}( |$))?[A-Za-z0-9 -]*\d[A-Za-z0-9 -]*$|^[A-Z]{2,3}$/.test(last)) {
    return null;
  }
  return parts[parts.length - 2] || null;
}
