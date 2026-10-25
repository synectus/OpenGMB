import { describe, expect, it } from "vitest";
import { MESSAGES } from "../messages";
import { LOCALES } from "./i18n";

/** Every leaf as "a.b.c" -> text (same shape as i18n.test.ts's flatten). */
function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

/** Keys allowed to name SynGMB, with why. authFlows.verify.descriptionLegacy: old authenticator entries are labeled SynGMB. */
const OLD_NAME_KEYS = new Set(["authFlows.verify.descriptionLegacy"]);
/** Keys where a translation may drop the product name. Empty: add one only with a reason. */
const PARITY_EXCEPTIONS = new Set<string>();

export function brandProblems(by: Record<string, Record<string, string>>): string[] {
  const out: string[] = [];
  const en = by.en!;
  for (const [locale, t] of Object.entries(by)) {
    for (const [k, v] of Object.entries(t)) {
      if (/SynGMB/.test(v) && !OLD_NAME_KEYS.has(k)) out.push(`${locale}: ${k} says SynGMB`);
      if (locale === "en" && /(^|[^A-Za-z])[Aa] OpenGMB\b/.test(v)) out.push(`en: ${k} says "a OpenGMB"`);
      if (locale !== "en" && /OpenGMB/.test(en[k] ?? "") && !/OpenGMB/.test(v) && !PARITY_EXCEPTIONS.has(k)) {
        out.push(`${locale}: ${k} drops OpenGMB`);
      }
    }
  }
  return out.sort();
}

describe("product name in the message catalogs", () => {
  it("canary: catches the old name, a lost brand and a wrong article", () => {
    expect(
      brandProblems({
        en: { "a.x": "Ask OpenGMB", "a.y": "a OpenGMB account", "a.z": "Hi" },
        hi: { "a.x": "पूछें", "a.y": "OpenGMB खाता", "a.z": "SynGMB" },
      }),
    ).toEqual(["en: a.y says \"a OpenGMB\"", "hi: a.x drops OpenGMB", "hi: a.z says SynGMB"]);
  });

  it("no catalog says SynGMB, and hi and es keep the name wherever English has it (prints the denominator)", () => {
    const by = Object.fromEntries(LOCALES.map((l) => [l, flatten(MESSAGES[l])]));
    const keys = Object.keys(by.en!).length;
    const branded = Object.values(by.en!).filter((v) => v.includes("OpenGMB")).length;
    console.log(`${keys} keys checked in ${LOCALES.length} languages; ${branded} English values name OpenGMB`);
    expect(keys).toBeGreaterThan(100);
    expect(branded).toBeGreaterThan(40); // about 57 English values named SynGMB at 99902c23
    expect(brandProblems(by)).toEqual([]);
  });

  it("the old-name keys exist and still mention both names", () => {
    for (const l of LOCALES) {
      for (const k of OLD_NAME_KEYS) {
        const v = flatten(MESSAGES[l])[k];
        expect(v, `${l} ${k}`).toMatch(/OpenGMB/);
        expect(v, `${l} ${k}`).toMatch(/SynGMB/);
      }
    }
  });
});
