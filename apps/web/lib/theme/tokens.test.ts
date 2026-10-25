// apps/web/lib/theme/tokens.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import { DARK, LIGHT, TOKEN_NAMES, themeCss, type TokenName, type Tokens } from "./tokens";

const TEXT = 4.5;
const UI = 3;
const TONES = ["good", "warn", "info", "bad", "agent"] as const satisfies readonly TokenName[];
const BANDS = [1, 2, 3, 4, 5] as const;

function get(t: Tokens, name: TokenName): string {
  const v = t[name];
  if (!v) throw new Error(`token ${name} is missing`);
  return v;
}

function pairs(t: Tokens) {
  const p = (label: string, fg: TokenName, bg: TokenName, min: number) => ({
    label,
    fg: get(t, fg),
    bg: get(t, bg),
    min,
  });
  return [
    p("foreground on background", "foreground", "background", TEXT),
    p("foreground on card", "foreground", "card", TEXT),
    p("muted-foreground on background", "muted-foreground", "background", TEXT),
    p("muted-foreground on card", "muted-foreground", "card", TEXT),
    p("muted-foreground on muted", "muted-foreground", "muted", TEXT),
    p("muted-foreground on secondary", "muted-foreground", "secondary", TEXT),
    p("primary-foreground on primary", "primary-foreground", "primary", TEXT),
    p("primary-foreground on primary-hover", "primary-foreground", "primary-hover", TEXT),
    p("brand-foreground on brand", "brand-foreground", "brand", TEXT),
    p("brand-text on background", "brand-text", "background", TEXT),
    p("brand-text on card", "brand-text", "card", TEXT),
    p("brand-text on brand-tint", "brand-text", "brand-tint", TEXT),
    p("destructive-foreground on destructive", "destructive-foreground", "destructive", TEXT),
    p("ring on background", "ring", "background", UI),
    p("ring on card", "ring", "card", UI),
    p("ring on muted", "ring", "muted", UI),
    p("ring on secondary", "ring", "secondary", UI),
    p("input on background", "input", "background", UI),
    p("input on card", "input", "card", UI),
    p("input on muted", "input", "muted", UI),
    p("card-foreground on card", "card-foreground", "card", TEXT),
    p("popover-foreground on popover", "popover-foreground", "popover", TEXT),
    p("secondary-foreground on secondary", "secondary-foreground", "secondary", TEXT),
    p("accent-foreground on accent", "accent-foreground", "accent", TEXT),
    p("primary on background", "primary", "background", TEXT),
    p("primary on card", "primary", "card", TEXT),
    p("destructive on background", "destructive", "background", TEXT),
    p("destructive on card", "destructive", "card", TEXT),
    p("foreground on brand-tint", "foreground", "brand-tint", TEXT),
    p("muted-foreground on brand-tint", "muted-foreground", "brand-tint", TEXT),
    ...TONES.flatMap((k) => [
      p(`${k} on ${k}-bg`, k, `${k}-bg` as TokenName, TEXT),
      p(`${k} on background`, k as TokenName, "background", TEXT),
      p(`${k} on card`, k as TokenName, "card", TEXT),
    ]),
    ...BANDS.map((n) => p(`band-${n}-foreground on band-${n}`, `band-${n}-foreground` as TokenName, `band-${n}` as TokenName, TEXT)),
  ];
}

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
] as const)("%s tokens", (_name, tokens) => {
  it.each(pairs(tokens))("$label is at least $min:1", ({ fg, bg, min }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe("token set", () => {
  it("has the full set (denominator)", () => {
    expect(TOKEN_NAMES.length).toBe(51);
  });

  it("light and dark define the same names", () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  it("every value is #rrggbb", () => {
    for (const v of [...Object.values(LIGHT), ...Object.values(DARK)]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("themeCss", () => {
  const css = themeCss();
  it("writes light on :root, dark on data-theme and on the system preference", () => {
    expect(css).toContain(":root{color-scheme:light;");
    expect(css).toContain("--primary:#c2410c");
    expect(css).toContain('\n:root[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain("--primary:#f96535");
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])');
  });

  it("refuses values that could break out of the declaration", () => {
    const out = themeCss({ primary: "#fff;}body{display:none" } as Partial<Tokens>, {});
    expect(out).not.toContain("display:none");
  });

  it("refuses names that are not tokens", () => {
    const out = themeCss({ ["not-a-token" as TokenName]: "#ffffff" }, {});
    expect(out).not.toContain("not-a-token");
  });

  it("skips undefined values", () => {
    const out = themeCss({ primary: undefined }, {});
    expect(out).not.toContain("undefined");
  });
});

describe("globals.css", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  it.each(TOKEN_NAMES)("maps --color-%s to its variable", (name) => {
    expect(css).toContain(`--color-${name}: var(--${name});`);
  });
  it("binds the dark: variant to data-theme", () => {
    expect(css).toContain("@custom-variant dark");
    expect(css).toContain('[data-theme="dark"]');
  });
});
