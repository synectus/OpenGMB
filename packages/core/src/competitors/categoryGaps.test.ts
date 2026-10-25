import { describe, expect, it } from "vitest";
import { categoriesCompetitorsHaveThatLocationLacks } from "./categoryGaps";

const comp = (placeId: string, primary: string | null, additional: string[], appearances: number) => ({
  placeId,
  title: `Biz ${placeId}`,
  appearances,
  primary,
  additional,
  ids: [],
  fetchedAt: "2026-10-24T00:00:00.000Z",
});

// Competitors arrive sorted by appearances, so list position is the rank.
const data = {
  competitors: [
    comp("a", "Dentist", ["Emergency dental service", "Teeth whitening service"], 30),
    comp("b", "Emergency dental service", ["Dentist"], 20),
    comp("c", "Orthodontist", ["Emergency dental service"], 10),
  ],
};

describe("categoriesCompetitorsHaveThatLocationLacks", () => {
  it("lists what competitors use and the location lacks, with who and their rank", () => {
    const out = categoriesCompetitorsHaveThatLocationLacks(data, ["Dentist"]);
    expect(out.map((g) => g.name)).toEqual(["Emergency dental service", "Orthodontist", "Teeth whitening service"]);
    const emergency = out[0]!;
    expect(emergency).toMatchObject({ competitors: 3, asPrimary: 1 });
    expect(emergency.evidence.map((e) => [e.placeId, e.rank, e.isPrimary])).toEqual([
      ["a", 1, false],
      ["b", 2, true],
      ["c", 3, false],
    ]);
  });

  it("matches the location's categories ignoring case and spaces, and returns nothing when none are lacking", () => {
    expect(categoriesCompetitorsHaveThatLocationLacks(data, [" dentist ", "EMERGENCY DENTAL SERVICE", "orthodontist", "Teeth whitening service"])).toEqual([]);
  });

  it("canary: with no own categories every competitor category is a gap (the check inspects something)", () => {
    const out = categoriesCompetitorsHaveThatLocationLacks(data, []);
    expect(out.map((g) => g.name).sort()).toEqual(["Dentist", "Emergency dental service", "Orthodontist", "Teeth whitening service"]);
  });

  it("counts a competitor once per category even if it repeats it, and handles no competitors", () => {
    const dup = { competitors: [comp("a", "Orthodontist", ["Orthodontist"], 5)] };
    expect(categoriesCompetitorsHaveThatLocationLacks(dup, [])[0]).toMatchObject({ competitors: 1, asPrimary: 1 });
    expect(categoriesCompetitorsHaveThatLocationLacks({ competitors: [] }, ["Dentist"])).toEqual([]);
  });
});
