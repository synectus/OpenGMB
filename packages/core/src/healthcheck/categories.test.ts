import { describe, expect, it } from "vitest";
import { categoryKey, missingCompetitorCategories, ownCategoryKeys, shareUsing, type CompetitorCats } from "./categories";

const comp = (primary: string, additional: string[] = [], ids: string[] = []): CompetitorCats => ({ primary, additional, ids });
const own = {
  primary: { name: "categories/gcid:dentist", displayName: "Dentist" },
  additional: [{ name: "categories/gcid:orthodontist" }],
};

describe("category matching", () => {
  it("one key for a display name, a gcid and a Google resource name", () => {
    expect(categoryKey("Real estate agency")).toBe("real estate agency");
    expect(categoryKey("gcid:real_estate_agency")).toBe("real estate agency");
    expect(categoryKey("categories/gcid:real_estate_agency")).toBe("real estate agency");
    expect(ownCategoryKeys(own.primary).has("dentist")).toBe(true);
  });
  it("shareUsing counts competitors using the category as primary or additional, matching by name or id", () => {
    const cs = [comp("Dentist"), comp("Orthodontist", ["Dentist"]), comp("Cosmetic dentist", [], ["gcid:dentist"]), comp("Orthodontist")];
    expect(shareUsing(ownCategoryKeys(own.primary), cs)).toEqual({ using: 3, total: 4 });
    expect(shareUsing(ownCategoryKeys(own.primary), [])).toEqual({ using: 0, total: 0 });
  });
});

describe("missingCompetitorCategories (reused by K3 suggestions with minShare 0)", () => {
  const cs = [comp("Dentist", ["Teeth whitener"]), comp("Dentist", ["Teeth whitener", "Dental clinic"]), comp("Dentist", ["Orthodontist"]), comp("Dentist")];
  it("lists categories used by at least minShare of competitors that the listing lacks, most used first", () => {
    expect(missingCompetitorCategories(own, cs, 0.5)).toEqual([{ name: "Teeth whitener", competitors: 2, total: 4 }]);
    expect(missingCompetitorCategories(own, cs, 0)).toEqual([
      { name: "Teeth whitener", competitors: 2, total: 4 },
      { name: "Dental clinic", competitors: 1, total: 4 },
    ]);
  });
  it("never lists a category the listing already has, and is empty without competitors", () => {
    expect(missingCompetitorCategories(own, cs, 0).map((m) => m.name)).not.toContain("Orthodontist");
    expect(missingCompetitorCategories(own, [], 0)).toEqual([]);
  });
});
