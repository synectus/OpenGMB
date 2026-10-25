// apps/web/lib/theme/tokens.ts
// The single source of colour for the web app. Values: approved canvas 0 (SynGMB UI, 2026-10-18)
// and the Synectus brand tokens (verified 2026-08-22).
// Names follow shadcn/ui so generated components work unchanged; the rest are SynGMB additions.
// tokens.test.ts checks every text pair against WCAG AA in both themes.

export const LIGHT = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  card: "#ffffff",
  "card-foreground": "#1a1a1a",
  popover: "#ffffff",
  "popover-foreground": "#1a1a1a",
  primary: "#c2410c",
  "primary-foreground": "#ffffff",
  "primary-hover": "#9a3412",
  secondary: "#f1f1f2",
  "secondary-foreground": "#1a1a1a",
  muted: "#f6f6f7",
  "muted-foreground": "#5c5f66",
  accent: "#f1f1f2",
  "accent-foreground": "#1a1a1a",
  destructive: "#b42318",
  "destructive-foreground": "#ffffff",
  border: "#e6e4e1",
  input: "#8b8e94",
  ring: "#e0501f",
  brand: "#f96535",
  "brand-foreground": "#1a1a1a",
  "brand-text": "#c2410c",
  "brand-tint": "#fff1eb",
  overlay: "#1a2b47",
  "chart-1": "#f96535",
  good: "#166534",
  "good-bg": "#e8f6ee",
  "good-border": "#b6e2c6",
  warn: "#8a5a00",
  "warn-bg": "#fff6db",
  "warn-border": "#f1d98c",
  info: "#1e4fd8",
  "info-bg": "#ecf2ff",
  "info-border": "#c9d6f5",
  bad: "#b42318",
  "bad-bg": "#fdeeed",
  "bad-border": "#f5c2bd",
  agent: "#1e3a8a",
  "agent-bg": "#f3f6fd",
  "agent-border": "#c9d6f5",
  "band-1": "#166534",
  "band-1-foreground": "#ffffff",
  "band-2": "#4d7c0f",
  "band-2-foreground": "#ffffff",
  "band-3": "#a16207",
  "band-3-foreground": "#ffffff",
  "band-4": "#c2410c",
  "band-4-foreground": "#ffffff",
  "band-5": "#3d4047",
  "band-5-foreground": "#ffffff",
} as const;

export type TokenName = keyof typeof LIGHT;
export type Tokens = Record<TokenName, string>;

export const DARK: Tokens = {
  background: "#0e1420",
  foreground: "#f1f2f4",
  card: "#151d2c",
  "card-foreground": "#f1f2f4",
  popover: "#151d2c",
  "popover-foreground": "#f1f2f4",
  primary: "#f96535",
  "primary-foreground": "#1a1a1a",
  "primary-hover": "#ff7851",
  secondary: "#1f2737",
  "secondary-foreground": "#f1f2f4",
  muted: "#0a0f18",
  "muted-foreground": "#a7afbf",
  accent: "#1f2737",
  "accent-foreground": "#f1f2f4",
  destructive: "#ff8e85",
  "destructive-foreground": "#1a1a1a",
  border: "#243047",
  input: "#5e6d8a",
  ring: "#f96535",
  brand: "#f96535",
  "brand-foreground": "#1a1a1a",
  "brand-text": "#ff8a5c",
  "brand-tint": "#342123",
  overlay: "#000000",
  "chart-1": "#f96535",
  good: "#6fd39a",
  "good-bg": "#123222",
  "good-border": "#1f4a33",
  warn: "#f2c14e",
  "warn-bg": "#2a2110",
  "warn-border": "#5a4514",
  info: "#8fb2ff",
  "info-bg": "#16254a",
  "info-border": "#2b3f72",
  bad: "#ff8e85",
  "bad-bg": "#3a1614",
  "bad-border": "#6b2a25",
  agent: "#b9ccff",
  "agent-bg": "#16254a",
  "agent-border": "#2b3f72",
  // Rank bands are a data encoding: identical in both themes, rank printed in every cell.
  "band-1": "#166534",
  "band-1-foreground": "#ffffff",
  "band-2": "#4d7c0f",
  "band-2-foreground": "#ffffff",
  "band-3": "#a16207",
  "band-3-foreground": "#ffffff",
  "band-4": "#c2410c",
  "band-4-foreground": "#ffffff",
  "band-5": "#3d4047",
  "band-5-foreground": "#ffffff",
};

export const TOKEN_NAMES = Object.keys(LIGHT) as TokenName[];

const NAMES = new Set<string>(TOKEN_NAMES);
const HEX = /^#[0-9a-f]{6}$/i;

// Only known token names with #rrggbb values reach the stylesheet, so a bad value cannot break out.
const decls = (t: Partial<Tokens>) =>
  Object.entries(t)
    .filter(([k, v]) => NAMES.has(k) && typeof v === "string" && HEX.test(v))
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");

/**
 * CSS variables for both themes. `data-theme` on <html> forces a theme; without it the system
 * preference decides. Later <style> tags with the same selectors (agency branding) override.
 */
export function themeCss(light: Partial<Tokens> = LIGHT, dark: Partial<Tokens> = DARK): string {
  return [
    `:root{color-scheme:light;${decls(light)}}`,
    `:root[data-theme="dark"]{color-scheme:dark;${decls(dark)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${decls(dark)}}}`,
  ].join("\n");
}
