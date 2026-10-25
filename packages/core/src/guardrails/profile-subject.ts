import type { ProfileGuardFields } from "./types";

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

/**
 * Canonical string for everything a profile write would send: keys sorted, undefined dropped, so
 * the same fields always give the same string and any changed value gives a different one.
 */
export function profileSubject(profile: ProfileGuardFields): string {
  return JSON.stringify(stable(profile));
}
