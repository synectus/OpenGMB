import { describe, expect, it } from "vitest";
import type { Competitor } from "./analytics";
import { diffCompetitorSnapshots, snapshotRowsFromPoints, type SnapshotRow } from "./competitor-snapshots";

const c = (rank: number, placeId: string | null, title: string, rating: number | null, reviewCount: number | null, isTarget = false): Competitor => ({
  rank,
  title,
  placeId,
  rating,
  reviewCount,
  isTarget,
  address: `${title} St`,
});

describe("snapshotRowsFromPoints", () => {
  it("aggregates per place id, leaves out the target and businesses without a place id", () => {
    const rows = snapshotRowsFromPoints([
      { competitors: [c(1, "A", "Alpha", 4.5, 100), c(2, "T", "Me", 4, 10, true), c(3, null, "No id", 4, 5)] },
      { competitors: [c(3, "A", "Alpha", 4.5, 100), c(1, "B", "Beta", 4.1, 50)] },
    ]);
    expect(rows).toEqual([
      { placeId: "A", title: "Alpha", address: "Alpha St", appearances: 2, averageRank: 2, bestRank: 1, rating: 4.5, reviewCount: 100 },
      { placeId: "B", title: "Beta", address: "Beta St", appearances: 1, averageRank: 1, bestRank: 1, rating: 4.1, reviewCount: 50 },
    ]);
  });
  it("is empty for no points", () => {
    expect(snapshotRowsFromPoints([])).toEqual([]);
  });
});

const row = (placeId: string, averageRank: number, rating: number | null, reviewCount: number | null, appearances = 5): SnapshotRow => ({
  placeId,
  title: placeId,
  address: null,
  appearances,
  averageRank,
  bestRank: 1,
  rating,
  reviewCount,
});

describe("diffCompetitorSnapshots", () => {
  it("marks new, dropped and continuing rows with rank, review and rating changes", () => {
    const out = diffCompetitorSnapshots(
      [row("A", 2, 4.6, 112), row("N", 4, 4, 9, 3)],
      [row("A", 3.5, 4.5, 100), row("D", 5, 4, 20)],
    );
    expect(out.map((r) => [r.placeId, r.status])).toEqual([
      ["A", "continuing"],
      ["N", "new"],
      ["D", "dropped"],
    ]);
    expect(out[0]).toMatchObject({ rankChange: 1.5, reviewsAdded: 12, ratingChange: 0.1 });
    expect(out[1]).toMatchObject({ rankChange: null, reviewsAdded: null });
  });
  it("flags nothing as new on the first snapshot, and leaves unknown counts null", () => {
    expect(diffCompetitorSnapshots([row("A", 2, null, null)], null)[0]).toMatchObject({ status: "continuing", rankChange: null });
    expect(diffCompetitorSnapshots([row("A", 2, null, null)], [row("A", 2, 4, 3)])[0]).toMatchObject({ reviewsAdded: null, ratingChange: null, rankChange: 0 });
  });
  it("ignores a previous snapshot from another data source", () => {
    const out = diffCompetitorSnapshots(
      [{ ...row("L", 2, 4, 10), dataSource: "live" }],
      [{ ...row("F", 3, 4, 10), dataSource: "fixture" }],
    );
    expect(out.map((r) => [r.placeId, r.status])).toEqual([["L", "continuing"]]);
  });
});
