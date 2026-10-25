// Pure Branding page logic. Client-safe (theme helpers only).
import { brandTokens, shellBrand } from "./theme/brand";
import { contrast, isHex, WHITE } from "./theme/color";
import { LIGHT } from "./theme/tokens";

export type BrandingInput = { agencyName?: string; logoUrl: string; primaryColor: string; accentColor: string };

/** The canvas error for the first bad field, before anything is sent. Empty fields clear and are fine. */
export function brandingInputError(v: Omit<BrandingInput, "agencyName">): string | null {
  for (const c of [v.primaryColor, v.accentColor]) {
    if (c.trim() !== "" && !isHex(c.trim())) return "INVALID_INPUT: Use a colour like #1d4ed8.";
  }
  if (v.logoUrl.trim() !== "" && !v.logoUrl.trim().startsWith("https://")) {
    return "INVALID_INPUT: The logo URL must start with https://.";
  }
  return null;
}

/** Rounded down, so 4.48 reads 4.4 and never looks like a pass. */
const ratio = (r: number) => (Math.floor(r * 10) / 10).toFixed(1);

/** What the app will do with this primary colour in the light theme, from brandTokens itself. */
export function contrastReadout(primary: string): { tone: "good" | "warn"; text: string } | null {
  const hex = primary.trim().toLowerCase();
  if (!isHex(hex)) return null;
  const light = brandTokens({ primaryColor: hex, accentColor: null })!.light;
  const bg = light.primary!;
  const white = light["primary-foreground"] === WHITE;
  if (white && bg === hex) {
    return { tone: "good", text: `White text on ${hex}: ${ratio(contrast(WHITE, hex))}:1, passes` };
  }
  if (white) {
    return { tone: "warn", text: `White text on ${hex} is too faint, so buttons use a darker shade, ${bg}.` };
  }
  if (bg === hex) {
    return { tone: "warn", text: `White text on ${hex} is too faint, so buttons use near-black text.` };
  }
  return {
    tone: "warn",
    text: `White text on ${hex} is too faint, so buttons use near-black text on a darker shade, ${bg}, that stands out on a white page.`,
  };
}

/** CSS variables for the preview: the whole light theme plus this form's overrides (validated hex only). */
export function previewStyle(primary: string, accent: string): Record<string, string> {
  const t = brandTokens({ primaryColor: primary.trim() || null, accentColor: accent.trim() || null });
  const tokens: Record<string, string> = { ...LIGHT, ...(t?.light ?? {}) };
  return Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v]));
}

/** The header block the preview draws: the same rule as the real shell (shellBrand). */
export function previewBrand(v: BrandingInput): { name: string; mark: string; logoUrl: string | null; branded: boolean } {
  const logo = v.logoUrl.trim().startsWith("https://") ? v.logoUrl.trim() : null;
  const s = shellBrand({
    agencyName: v.agencyName ?? "",
    logoUrl: logo,
    primaryColor: v.primaryColor.trim() || null,
    accentColor: v.accentColor.trim() || null,
  });
  return { name: s.name, mark: s.mark, logoUrl: s.logoUrl, branded: s.subline !== "by Synectus" };
}
