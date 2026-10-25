export const THEME_COOKIE = "syngmb_theme";
export const DENSITY_COOKIE = "syngmb_density";

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];
export const DENSITIES = ["compact", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

/** Spec §2: scopes with this many active locations or fewer start Comfortable. */
export const COMFORTABLE_MAX_LOCATIONS = 3;

export function parseTheme(v: string | undefined): Theme {
  return (THEMES as readonly string[]).includes(v ?? "") ? (v as Theme) : "system";
}

export function parseDensity(v: string | undefined): Density | null {
  return (DENSITIES as readonly string[]).includes(v ?? "") ? (v as Density) : null;
}

export function defaultDensity(activeLocations: number): Density {
  return activeLocations <= COMFORTABLE_MAX_LOCATIONS ? "comfortable" : "compact";
}
