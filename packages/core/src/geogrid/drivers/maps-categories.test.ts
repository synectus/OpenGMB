import { describe, expect, it } from "vitest";
import { parseDataForSeoTaskGet } from "./dataforseo";
import { fixtureDataForSeoTransport, type DfsTaskGetResponse } from "./fixtures";
import { resolvePointResult } from "./index";
import { competitorTable } from "../analytics";
import { snapshotRowsFromPoints } from "../competitor-snapshots";

const response = (items: unknown[]): DfsTaskGetResponse =>
  ({
    version: "x",
    status_code: 20000,
    status_message: "Ok.",
    tasks_count: 1,
    tasks: [{ id: "t1", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ keyword: "k", type: "maps", items_count: items.length, items }] }],
  }) as unknown as DfsTaskGetResponse;

// Fields per https://docs.dataforseo.com/v3/serp/google/maps/task_get/advanced/ (verified 2026-10-24).
const WITH = { type: "maps_search", rank_group: 1, rank_absolute: 1, title: "Acme Dental", place_id: "p1", cid: "1", category: "Dentist", additional_categories: ["Cosmetic dentist"], category_ids: ["dentist", "cosmetic_dentist"], rating: null };
const WITHOUT = { type: "maps_search", rank_group: 2, rank_absolute: 2, title: "Bare Dental", place_id: "p2", cid: "2", rating: null };

describe("K2c: categories on Maps results", () => {
  it("parses category, additional_categories and category_ids; absent fields give null and empty lists", () => {
    const r = parseDataForSeoTaskGet(response([WITH, WITHOUT]));
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ category: "Dentist", additionalCategories: ["Cosmetic dentist"], categoryIds: ["dentist", "cosmetic_dentist"] });
    expect(r[1]).toMatchObject({ category: null, additionalCategories: [], categoryIds: [] });
  });

  it("canary: the fixture carries the documented fields, and they reach the snapshot rows", async () => {
    const transport = fixtureDataForSeoTransport();
    const posted = await transport.taskPost([
      { keyword: "emergency dentist", location_coordinate: "29.4241,-98.4936,15z", language_code: "en", device: "desktop", depth: 20, tag: JSON.stringify({ c: [29.4241, -98.4936], n: "Nobody", p: null }) },
    ]);
    const res = await transport.taskGet(posted.tasks[0]!.id);
    const parsed = parseDataForSeoTaskGet(res);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((x) => x.category && x.categoryIds!.length > 0)).toBe(true);
    const point = resolvePointResult(parsed, { name: "Nobody", placeId: null, domain: null } as never);
    const rows = snapshotRowsFromPoints([point]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.category)).toBe(true);
  });

  it("competitorTable keeps the first categories seen; results without any stay null", () => {
    const parsed = parseDataForSeoTaskGet(response([WITH, WITHOUT]));
    const point = resolvePointResult(parsed, { name: "Nobody", placeId: null, domain: null } as never);
    const t = competitorTable([point]);
    expect(t.find((c) => c.placeId === "p1")).toMatchObject({ category: "Dentist", additionalCategories: ["Cosmetic dentist"] });
    expect(t.find((c) => c.placeId === "p2")?.category).toBeUndefined();
  });
});
