// apps/web/lib/theme/color.ts
export const WHITE = "#ffffff";
/** Near-black text colour from the Synectus brand tokens. */
export const INK = "#1a1a1a";

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

function channels(hex: string): [number, number, number] {
  const h = hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `a` moved toward `b` by `t` (0 to 1), channel by channel. */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const p = channels(a);
  const q = channels(b);
  return `#${p.map((v, i) => Math.round(v + (q[i]! - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `color` moved toward `toward` in 5% steps until it reaches `min` contrast against `against`.
 * Best effort: if even `toward` does not reach `min`, it returns `toward`. Callers pass the opposite
 * extreme of `against` (black for a light background, white for a dark one), which is the case where
 * the result reaches the minimum.
 */
export function ensureContrast(color: string, against: string, toward: string, min = 4.5): string {
  for (let i = 0; i <= 20; i++) {
    const c = mix(color, toward, i / 20);
    if (contrast(c, against) >= min) return c;
  }
  return toward;
}

/** A button fill and a text colour with at least 4.5:1: white text first, then near-black, else darken. */
export function buttonPair(bg: string): { bg: string; fg: string } {
  if (contrast(bg, WHITE) >= 4.5) return { bg, fg: WHITE };
  if (contrast(bg, INK) >= 4.5) return { bg, fg: INK };
  return { bg: ensureContrast(bg, WHITE, "#000000"), fg: WHITE };
}
