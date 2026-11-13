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

/**
 * ICU argument names such as {email}, sorted and unique: a translation must keep every one. The branch keywords of
 * select and plural ("over", "other", "one") and the words inside a branch are text, not arguments; arguments used
 * inside a branch count. Unique, because a translation may repeat an argument in each branch.
 */
export function placeholders(s: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      let depth = 1;
      let j = i + 1;
      for (; j < text.length && depth > 0; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
      const m = /^\s*(\w+)\s*(?:,\s*(\w+)\s*(?:,([\s\S]*))?)?$/.exec(text.slice(i + 1, j - 1));
      if (m) {
        names.add(m[1]!);
        if (m[3] !== undefined && /^(select|plural|selectordinal)$/.test(m[2]!)) {
          let d = 0;
          let from = 0;
          for (let k = 0; k < m[3].length; k++) {
            if (m[3][k] === "{" && d++ === 0) from = k + 1;
            else if (m[3][k] === "}" && --d === 0) walk(m[3].slice(from, k));
          }
        }
      }
      i = j - 1;
    }
  };
  walk(s);
  return [...names].sort();
}

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

  it("canary: select and plural branch words are not placeholders, arguments inside a branch are", () => {
    expect(placeholders("{kind, select, over {over} other {about}} {n, number}")).toEqual(["kind", "n"]);
    expect(placeholders("{kind, select, over {{n, number} más} other {unos {n, number}}} {grid} x {grid}")).toEqual(["grid", "kind", "n"]);
    expect(placeholders("{count, plural, one {# result} other {# results}} in {where}")).toEqual(["count", "where"]);
    expect(problems({ "a.k": "{k, select, over {over} other {about}} {n}" }, { "a.k": "{k, select, over {más} other {unos}}" })).toEqual(["placeholders differ: a.k"]);
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
