import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, parseLocale } from "./i18n";
import { MESSAGES } from "../messages";
import { navFor } from "./nav";
import { settingsNavFor } from "./settings-nav";

/** Every leaf as "a.b.c" -> text. Keys with spaces are fine; no key contains a dot. */
export function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

/** ICU placeholders such as {email}, sorted: a translation must keep every one. */
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

/** The checker: what is wrong between the reference language and another. Empty means fine. */
export function problems(reference: Record<string, string>, other: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(reference)) {
    if (!(key in other)) out.push(`missing: ${key}`);
    else if (other[key]!.trim() === "") out.push(`empty: ${key}`);
    else if (placeholders(reference[key]!).join() !== placeholders(other[key]!).join()) out.push(`placeholders differ: ${key}`);
  }
  for (const key of Object.keys(other)) if (!(key in reference)) out.push(`extra: ${key}`);
  return out;
}

const en = flatten(MESSAGES.en);

describe("message files", () => {
  it("has three languages and prints the denominator", () => {
    expect(LOCALES).toEqual(["en", "hi", "es"]);
    expect(Object.keys(en).length).toBeGreaterThan(100);
    console.log(`${Object.keys(en).length} keys checked in ${LOCALES.length} languages`);
  });

  it("canary: the checker catches a missing key, an empty one, a lost placeholder and an extra", () => {
    const ref = { "a.one": "Hello {name}", "a.two": "Two" };
    expect(problems(ref, { "a.one": "Hola {name}", "a.two": "Dos" })).toEqual([]);
    expect(problems(ref, { "a.one": "Hola {name}" })).toEqual(["missing: a.two"]);
    expect(problems(ref, { "a.one": "Hola {name}", "a.two": " " })).toEqual(["empty: a.two"]);
    expect(problems(ref, { "a.one": "Hola", "a.two": "Dos" })).toEqual(["placeholders differ: a.one"]);
    expect(problems(ref, { "a.one": "Hola {name}", "a.two": "Dos", "a.three": "x" })).toEqual(["extra: a.three"]);
  });

  for (const locale of LOCALES) {
    it(`${locale} has every key of English and nothing else`, () => {
      expect(problems(en, flatten(MESSAGES[locale]))).toEqual([]);
    });
  }

  it("Hindi and Spanish are actually translated (most values differ from English)", () => {
    for (const locale of ["hi", "es"] as const) {
      const t = flatten(MESSAGES[locale]);
      const same = Object.keys(en).filter((k) => t[k] === en[k]).length;
      expect(same / Object.keys(en).length).toBeLessThan(0.2);
    }
  });
});

describe("every sidebar and settings label has a translation", () => {
  const all = () => true;
  const labels = new Set<string>();
  for (const g of navFor(all, { "/approvals": 1, "/reviews": 1, "/locations": 1 })) {
    if (g.label) labels.add(`nav.groups.${g.label}`);
    for (const i of g.items) {
      labels.add(`nav.items.${i.label}`);
      if (i.badgeLabel) labels.add(`nav.badges.${i.badgeLabel}`);
    }
  }
  for (const i of settingsNavFor(all, true)) labels.add(`nav.items.${i.label}`);

  it("covers the labels it found (denominator and canary)", () => {
    console.log(`${labels.size} nav labels checked`);
    expect(labels.size).toBeGreaterThan(20);
    expect(labels.has("nav.items.Needs attention")).toBe(true);
    expect(labels.has("nav.badges.need a reply")).toBe(true);
  });

  for (const locale of LOCALES) {
    it(`${locale} has them all`, () => {
      const t = flatten(MESSAGES[locale]);
      expect([...labels].filter((k) => !(k in t))).toEqual([]);
    });
  }
});

describe("parseLocale", () => {
  it("accepts the three languages and falls back to English for anything else", () => {
    expect(parseLocale("hi")).toBe("hi");
    expect(parseLocale("es")).toBe("es");
    expect(parseLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(parseLocale(undefined)).toBe("en");
    expect(parseLocale("../../etc")).toBe("en");
  });
});
