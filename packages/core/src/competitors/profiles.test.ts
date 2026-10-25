import { describe, expect, it, vi } from "vitest";
import type { CompetitorRow } from "../geogrid/analytics";
import { DFS_COUNTRY_LOCATIONS, dfsLocationCodeFor } from "../config/dfs-locations";
import {
  diffProfiles,
  fixtureProfileTransport,
  liveProfileTransport,
  parseDfsTimestamp,
  parseInfoItem,
  parseUpdatesResult,
  refreshCostUsd,
  selectTopCompetitors,
  weeklyRefreshEstimateUsd,
  type StoredProfile,
} from "./profiles";

// Shapes follow the DataForSEO docs read on 2026-10-24 (my_business_info/task_get, my_business_updates/task_get).
const INFO_ITEM = {
  type: "google_business_info",
  title: "Alamo Dental",
  place_id: "ChIJabc",
  category: "Dentist",
  additional_categories: ["Emergency dental service", "Cosmetic dentist"],
  category_ids: ["dentist", "emergency_dental_service", "cosmetic_dentist"],
  total_photos: 142,
  rating: { rating_type: "Max5", value: 4.7, votes_count: 311, rating_max: 5 },
};
const UPDATES_RESULT = {
  items_count: 3,
  items: [
    { type: "google_business_post", timestamp: "2026-10-01 00:00:00 +00:00", post_date: "10/01/2026 00:00:00" },
    { type: "google_business_post", timestamp: "2026-10-20 09:30:00 +00:00" },
    { type: "google_business_post", timestamp: "2026-09-10 00:00:00 +00:00" },
  ],
};

describe("parsers", () => {
  it("parses a my_business_info item (canary: must match the docs shape)", () => {
    expect(parseInfoItem(INFO_ITEM)).toEqual({
      categories: { primary: "Dentist", additional: ["Emergency dental service", "Cosmetic dentist"], ids: ["dentist", "emergency_dental_service", "cosmetic_dentist"] },
      totalPhotos: 142,
      rating: 4.7,
      reviewCount: 311,
    });
  });
  it("tolerates missing fields and a missing item", () => {
    expect(parseInfoItem(undefined)).toBeNull();
    expect(parseInfoItem({ type: "google_business_info" })).toEqual({
      categories: { primary: null, additional: [], ids: [] },
      totalPhotos: null,
      rating: null,
      reviewCount: null,
    });
  });
  it("parses the update timestamp format of the docs, with colons or hyphens in the time", () => {
    expect(parseDfsTimestamp("2020-04-02 00:00:00 +00:00")?.toISOString()).toBe("2020-04-02T00:00:00.000Z");
    expect(parseDfsTimestamp("2020-04-02 10-11-12 +00:00")?.toISOString()).toBe("2020-04-02T10:11:12.000Z");
    expect(parseDfsTimestamp("nonsense")).toBeNull();
    expect(parseDfsTimestamp(undefined)).toBeNull();
  });
  it("takes the newest post time and counts only post items", () => {
    expect(parseUpdatesResult(UPDATES_RESULT)).toEqual({ lastPostAt: new Date("2026-10-20T09:30:00Z"), postsCount: 3 });
    expect(parseUpdatesResult({ items: null })).toEqual({ lastPostAt: null, postsCount: 0 });
    expect(parseUpdatesResult(null)).toEqual({ lastPostAt: null, postsCount: 0 });
  });
});

describe("cost", () => {
  it("is info + updates task + one 10-update block, plus the markup, rounded up", () => {
    // 0.0015 + 0.0015 + 0.00075 = 0.00375 per profile
    expect(refreshCostUsd(1, 0)).toBe(0.0038);
    expect(refreshCostUsd(10, 28)).toBe(0.048);
    expect(weeklyRefreshEstimateUsd(28)).toBe(0.048);
  });
});

const row = (business: string, placeId: string | null, appearances: number, isTarget = false): CompetitorRow => ({
  business,
  placeId,
  appearances,
  averageRank: 2,
  bestRank: 1,
  address: null,
  rating: null,
  reviewCount: null,
  isTarget,
});

describe("selectTopCompetitors", () => {
  it("sums appearances across keywords, caps, leaves out the target, skips and counts businesses without a place id", () => {
    const out = selectTopCompetitors(
      [
        [row("Alpha", "A", 5), row("Me", "T", 9, true), row("No id", null, 4), row("Beta", "B", 1)],
        [row("Alpha", "A", 2), row("Gamma", "G", 3), row("No id", null, 1)],
      ],
      3,
    );
    // Ranked: Alpha 7, No id 5, Gamma 3 (Beta 1 is cut).
    expect(out.top).toEqual([
      { placeId: "A", title: "Alpha", appearances: 7 },
      { placeId: "G", title: "Gamma", appearances: 3 },
    ]);
    expect(out.skippedNoPlaceId).toBe(1);
  });
  it("is empty for no data", () => {
    expect(selectTopCompetitors([])).toEqual({ top: [], skippedNoPlaceId: 0 });
  });
});

const base: StoredProfile = {
  categories: { primary: "Dentist", additional: ["Orthodontist"], ids: [] },
  totalPhotos: 100,
  rating: 4.5,
  reviewCount: 200,
  lastPostAt: new Date("2026-10-01T00:00:00Z"),
  postsCount: 4,
};
describe("diffProfiles", () => {
  it("reports photos, reviews, rating, categories and new posts", () => {
    const cur: StoredProfile = {
      ...base,
      categories: { primary: "Dentist", additional: ["Cosmetic dentist"], ids: [] },
      totalPhotos: 112,
      rating: 4.6,
      reviewCount: 215,
      lastPostAt: new Date("2026-10-20T00:00:00Z"),
    };
    expect(diffProfiles(cur, base)).toEqual({
      photosAdded: 12,
      reviewsAdded: 15,
      ratingChange: 0.1,
      categoriesAdded: ["Cosmetic dentist"],
      categoriesRemoved: ["Orthodontist"],
      postedSince: true,
    });
    expect(diffProfiles(base, base)).toMatchObject({ photosAdded: 0, categoriesAdded: [], categoriesRemoved: [], postedSince: false });
  });
  it("gives null deltas when a number was not known", () => {
    expect(diffProfiles({ ...base, totalPhotos: null }, base).photosAdded).toBeNull();
  });
});

describe("fixtureProfileTransport", () => {
  it("answers in the DataForSEO shape, deterministically, with no cost", async () => {
    const t = fixtureProfileTransport();
    const [posted] = await t.post("info", ["ChIJx"], 2840);
    expect(posted).toMatchObject({ placeId: "ChIJx", costUsd: 0 });
    const a = await t.get("info", posted!.ref!);
    const b = await t.get("info", posted!.ref!);
    expect(a).toEqual(b);
    expect(a.state).toBe("ready");
    const parsed = parseInfoItem((a as { result: { items: unknown[] } }).result.items[0]);
    expect(parsed?.categories.primary).toBeTruthy();
    const u = await t.get("updates", "fixture:updates:ChIJx");
    expect(u.state).toBe("ready");
  });
});

describe("liveProfileTransport request shape", () => {
  it("posts place_id keyword, location, language, tag and (updates) depth, with Basic auth, and maps task ids and cost", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "secret");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [
            { id: "t-1", status_code: 20100, cost: 0.0015, data: { tag: "A" } },
            { id: "", status_code: 40501, status_message: "Invalid Field", data: { tag: "B" } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const t = liveProfileTransport({ fetch: fetchStub });
      const out = await t.post("updates", ["A", "B"], 2356);
      expect(out).toEqual([
        { placeId: "A", ref: "t-1", costUsd: 0.0015 },
        { placeId: "B", ref: null, costUsd: 0, error: "40501 Invalid Field" },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toMatch(/\/v3\/business_data\/google\/my_business_updates\/task_post$/);
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual([
        { keyword: "place_id:A", location_code: 2356, language_code: "en", tag: "A", depth: 10 },
        { keyword: "place_id:B", location_code: 2356, language_code: "en", tag: "B", depth: 10 },
      ]);
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("dfsLocationCodeFor", () => {
  it("maps the verified countries, ignores case, and falls back to the US", () => {
    expect(["IN", "US", "AU", "GB", "CA", "NZ", "AE"].map(dfsLocationCodeFor)).toEqual([2356, 2840, 2036, 2826, 2124, 2554, 2784]);
    expect(dfsLocationCodeFor(" in ")).toBe(2356);
    expect(dfsLocationCodeFor("ZZ")).toBe(2840);
    expect(dfsLocationCodeFor(null)).toBe(2840);
    expect(dfsLocationCodeFor(undefined)).toBe(2840);
    expect(DFS_COUNTRY_LOCATIONS.verifiedOn).toBe("2026-10-24");
  });
});
