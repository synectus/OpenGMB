// apps/web/lib/theme/brand.ts
import type { Branding } from "@opengmb/core";
import { buttonPair, contrast, ensureContrast, isHex, mix, WHITE } from "./color";
import { DARK, LIGHT, themeCss, type Tokens } from "./tokens";

type Colours = Pick<Branding, "primaryColor" | "accentColor">;
type Overrides = Partial<Tokens>;

/** `color` stepped toward `toward` until it reaches `min` contrast against every surface. */
function ensureOnAll(color: string, surfaces: string[], toward: string, min: number): string {
  for (let i = 0; i <= 20; i++) {
    const c = mix(color, toward, i / 20);
    if (surfaces.every((s) => contrast(c, s) >= min)) return c;
  }
  return toward;
}

/** Brand token overrides for an agency, or null when it set no valid colour. */
export function brandTokens(b: Colours | null): { light: Overrides; dark: Overrides } | null {
  const primary = b && isHex(b.primaryColor) ? b.primaryColor.toLowerCase() : null;
  const accent = b && isHex(b.accentColor) ? b.accentColor.toLowerCase() : null;
  if (!primary && !accent) return null;

  const fill = accent ?? primary!;
  const brand = buttonPair(fill);
  // The ring must reach 3:1 on every surface; the theme's secondary is the worst case.
  const make = (theme: Tokens, tintWeight: number, toward: "#ffffff" | "#000000"): Overrides => {
    const bg = theme.background;
    const out: Overrides = {
      brand: brand.bg,
      "brand-foreground": brand.fg,
      "brand-tint": mix(fill, bg, tintWeight),
      ring: ensureContrast(fill, theme.secondary, toward, 3),
    };
    const textBase = primary ?? fill;
    // Brand text appears on the page, cards, secondary surfaces and its own tint (active nav item).
    const textSurfaces = [bg, theme.card, theme.secondary, out["brand-tint"]!];
    out["brand-text"] = ensureOnAll(textBase, textSurfaces, toward, 4.5);
    if (primary) {
      let button = buttonPair(primary);
      // A button must stand out from the page: near-black on dark or white on white would vanish.
      const buttonSurfaces = [bg, theme.card, theme.secondary];
      if (buttonSurfaces.some((x) => contrast(button.bg, x) < 3)) {
        button = buttonPair(ensureOnAll(button.bg, buttonSurfaces, toward, 3));
      }
      out.primary = button.bg;
      out["primary-foreground"] = button.fg;
      // Hover moves away from the text colour, so contrast only goes up.
      out["primary-hover"] = mix(button.bg, button.fg === WHITE ? "#000000" : "#ffffff", 0.15);
    }
    return out;
  };

  return { light: make(LIGHT, 0.9, "#000000"), dark: make(DARK, 0.84, "#ffffff") };
}

/** CSS that overrides the default theme for one organization, or null for the default brand. */
export function brandCss(b: Colours | null): string | null {
  const t = brandTokens(b);
  return t ? themeCss(t.light, t.dark) : null;
}

export type ShellBrand = { name: string; subline: string; mark: string; logoUrl: string | null };

/**
 * The top-left brand block. branding.get always returns an agencyName (it falls back to the
 * organization name), so "branded" means the agency set a logo or a colour.
 */
export function shellBrand(b: Branding | null): ShellBrand {
  const branded = Boolean(b && (b.logoUrl || isHex(b.primaryColor) || isHex(b.accentColor)));
  const name = branded && b ? b.agencyName.trim() || "OpenGMB" : "OpenGMB";
  return {
    name,
    subline: branded ? "Powered by OpenGMB" : "by Synectus",
    mark: name.trim().charAt(0).toUpperCase() || "O",
    logoUrl: branded && b?.logoUrl ? b.logoUrl : null,
  };
}
