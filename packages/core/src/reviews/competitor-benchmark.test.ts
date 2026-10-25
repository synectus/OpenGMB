import { describe, expect, it } from "vitest";
import { topCompetitors, velocityPer30Days } from "./competitor-benchmark";

const row = (placeId: string, appearances: number, averageRank: number, reviewCount: number | null = 10, rating: number | null = 4.5) => ({
  placeId,
  title: placeId.toUpperCase(),
  appearances,
  averageRank,
  rating,
  reviewCount,
});

describe("topCompetitors", () => {
  it("canary: orders by appearances then average rank and keeps three", () => {
    const out = topCompetitors([row("a", 5, 2), row("b", 9, 4), row("c", 9, 3), row("d", 1, 1), row("e", 7, 1)]);
    expect(out.map((c) => c.placeId)).toEqual(["c", "b", "e"]);
  });
  it("merges a business seen under several keywords", () => {
    const out = topCompetitors([row("a", 4, 2, 50, 4.2), row("a", 6, 4, 60, 4.4)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ appearances: 10, averageRank: 3.2, reviewCount: 60, rating: 4.4 });
  });
  it("returns nothing for no rows", () => expect(topCompetitors([])).toEqual([]));
});

describe("velocityPer30Days", () => {
  it("is null with fewer than 2 days", () => {
    expect(velocityPer30Days([])).toBeNull();
    expect(velocityPer30Days([{ day: "2026-10-01", reviewCount: 5 }])).toBeNull();
    expect(velocityPer30Days([{ day: "2026-10-01", reviewCount: 5 }, { day: "2026-10-01", reviewCount: 6 }])).toBeNull();
  });
  it("scales the change to 30 days", () => {
    expect(velocityPer30Days([{ day: "2026-10-11", reviewCount: 130 }, { day: "2026-10-01", reviewCount: 100 }])).toMatchObject({
      perThirtyDays: 90,
      days: 10,
      fromDay: "2026-10-01",
      toDay: "2026-10-11",
    });
  });
});
