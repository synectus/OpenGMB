import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import seoKeywordsCost from "../messages/pages/seoKeywordsCost";
import { cityFromAddress, countryFromAddress, formatVolume, intentLabel, kdLabel, priceLineText, refusalKind, researchErrorText, seoKeywordsHref, type Tr } from "./seo-keywords";

const tc = createTranslator({ locale: "en", messages: { c: seoKeywordsCost.en }, namespace: "c" }) as unknown as Tr;

describe("seo keyword display helpers", () => {
  it("formats volume", () => {
    expect(formatVolume(12345)).toBe("12,345");
    expect(formatVolume(null)).toBe("No data");
    expect(formatVolume(0)).toBe("0");
  });
  it("bands difficulty", () => {
    expect([kdLabel(0), kdLabel(29), kdLabel(30), kdLabel(59), kdLabel(60), kdLabel(100), kdLabel(null)]).toEqual(["Easy", "Easy", "Medium", "Medium", "Hard", "Hard", "No data"]);
    expect([kdLabel(15), kdLabel(45), kdLabel(75)]).toEqual(["Easy", "Medium", "Hard"]);
  });
  it("names intent in plain words", () => {
    expect(["commercial", "transactional", "informational", "navigational", "unknown", "weird"].map((i) => intentLabel(i))).toEqual(["Comparing", "Ready to buy", "Learning", "Looking for a site", "Unclear", "Unclear"]);
  });
  it("builds the page link", () => {
    expect(seoKeywordsHref()).toBe("/seo/keywords");
    expect(seoKeywordsHref({ ws: "w1", location: "l1" })).toBe("/seo/keywords?ws=w1&location=l1");
    expect(seoKeywordsHref({ run: "r1" })).toBe("/seo/keywords?run=r1");
  });
  it("finds the city and country in a Google address", () => {
    expect(cityFromAddress("12 Main St, Austin, TX 78701, US")).toBe("Austin");
    expect(cityFromAddress("Austin, TX")).toBe("Austin");
    expect(cityFromAddress("12 Main St")).toBeNull();
    expect(cityFromAddress("12 Main St, 78701")).toBeNull();
    expect(cityFromAddress(null)).toBeNull();
    expect(countryFromAddress("12 Main St, Austin, TX 78701, US")).toBe("US");
    expect(countryFromAddress("1 Rd, Sydney, NSW 2000, AU")).toBe("AU");
    expect(countryFromAddress("1 Rd, Paris, FR")).toBe("US");
    expect(countryFromAddress(null)).toBe("US");
  });

  it("the price line says credit only for a billed account", () => {
    const live = { chargedUsd: 0.21, cached: false, cachedAt: null, source: "live" as const };
    expect(priceLineText({ ...live, balanceUsd: 9.4 }, tc)).toBe("This search costs about $0.21 from your credit (balance $9.40).");
    const community = priceLineText({ ...live, balanceUsd: null }, tc);
    expect(community).toBe("This search costs about $0.21.");
    expect(community).not.toMatch(/credit/);
    expect(priceLineText({ ...live, balanceUsd: null, cached: true, cachedAt: "2026-11-10T01:00:00Z" }, tc)).toBe("Free: you ran this search on 2026-11-10.");
    expect(priceLineText({ ...live, source: "fixture", balanceUsd: null }, tc)).toMatch(/^Free in sample mode/);
    const running = priceLineText({ ...live, balanceUsd: 9.4, cached: true, cachedAt: "2026-11-10T01:00:00Z", inFlight: true }, tc);
    expect(running).toBe("This search is already running. It costs nothing more.");
    expect(running).not.toMatch(/ran this search/);
  });
  it("refusals become plain sentences, not CODE: message", () => {
    const cases: [{ code: string; message: string }, string | null][] = [
      [{ code: "FORBIDDEN", message: "CREDIT_EXHAUSTED: need 210000, have 0" }, "credit"],
      [{ code: "FORBIDDEN", message: "BUDGET_EXCEEDED: this geo-grid run would cost $0.21" }, "budget"],
      [{ code: "FORBIDDEN", message: "PLATFORM_CAP_EXCEEDED: rank scans are paused" }, "platform"],
      [{ code: "FORBIDDEN", message: "Not allowed" }, "forbidden"],
      [{ code: "INVALID_INPUT", message: "Pick a city from the list" }, null],
    ];
    for (const [e, kind] of cases) {
      expect(refusalKind(e)).toBe(kind);
      const text = researchErrorText(e, tc);
      expect(text).not.toMatch(/^[A-Z_]+:/);
      expect(text).not.toMatch(/geo-grid|rank scan/i);
      expect(text.includes(String.fromCharCode(0x2014))).toBe(false);
    }
    expect(researchErrorText(cases[4]![0], tc)).toBe("Pick a city from the list");
  });
});
