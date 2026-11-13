import { describe, expect, it } from "vitest";
import { DfsAccountError } from "../../geogrid/drivers/errors";
import { DfsTaskError, fixtureKeywordTransport, liveKeywordTransport } from "./transport";
import { SEO_PRICES } from "../../config/seo";
import { SEO_ENDPOINTS } from "../../config/seo";

describe("keyword transport", () => {
  it("fixture: suggestions and ideas return rows, Ads returns local volume, costs are 0", async () => {
    const t = fixtureKeywordTransport();
    const s = await t.labs("suggestions", { seed: "plumber", locationCode: 2840, languageCode: "en", limit: 75 });
    expect(s.items.length).toBeGreaterThan(5);
    expect(s.costUsd).toBe(0);
    const ads = await t.adsVolume({ keywords: ["plumber"], locationName: "Austin,Texas,United States", languageCode: "en" });
    expect(ads.items[0]).toMatchObject({ keyword: "plumber" });
    expect(ads.costUsd).toBe(0);
  });
  it("live: posts the documented bodies and reads task cost; account errors are typed", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.0216, result: [{ items: [{ keyword: "plumber" }] }] }] }));
    };
    const t = liveKeywordTransport({ fetch: fake, credentials: async () => ({ login: "l", password: "p" }) });
    const r = await t.labs("ideas", { seed: "plumber", locationCode: 2840, languageCode: "en", limit: 75 });
    expect(calls[0]!.url).toContain(SEO_ENDPOINTS.labsIdeas);
    expect(calls[0]!.body).toEqual([{ keywords: ["plumber"], location_code: 2840, language_code: "en", limit: 75, include_serp_info: false, include_clickstream_data: false }]);
    expect(r).toMatchObject({ costUsd: 0.0216, items: [{ keyword: "plumber" }] });
    await t.labs("suggestions", { seed: "plumber", locationCode: 2840, languageCode: "en", limit: 75 });
    expect(calls[1]!.url).toContain(SEO_ENDPOINTS.labsSuggestions);
    expect(calls[1]!.body).toEqual([{ keyword: "plumber", location_code: 2840, language_code: "en", limit: 75, include_serp_info: false, include_clickstream_data: false, include_seed_keyword: true }]);
    await t.adsVolume({ keywords: ["a"], locationName: "Austin,Texas,United States", languageCode: "en" });
    expect(calls[2]!.url).toContain(SEO_ENDPOINTS.adsSearchVolume);
    expect(calls[2]!.body).toEqual([{ keywords: ["a"], location_name: "Austin,Texas,United States", language_code: "en" }]);
    const denied = liveKeywordTransport({ fetch: async () => new Response("{}", { status: 402 }), credentials: async () => ({ login: "l", password: "p" }) });
    await expect(denied.labs("suggestions", { seed: "x", locationCode: 2840, languageCode: "en", limit: 10 })).rejects.toBeInstanceOf(DfsAccountError);
  });
  it("live: seed_keyword_data leads the suggestions; Ads result has no items wrapper", async () => {
    let n = 0;
    const fake: typeof fetch = async () => {
      n++;
      const result = n === 1 ? [{ seed_keyword_data: { keyword: "seed" }, items: [{ keyword: "seed a" }] }] : [{ keyword: "seed a", search_volume: 5 }];
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.1, result }] }));
    };
    const t = liveKeywordTransport({ fetch: fake, credentials: async () => ({ login: "l", password: "p" }) });
    expect((await t.labs("suggestions", { seed: "seed", locationCode: 1, languageCode: "en", limit: 5 })).items.map((i) => i.keyword)).toEqual(["seed", "seed a"]);
    expect((await t.adsVolume({ keywords: ["seed a"], locationName: "X", languageCode: "en" })).items[0]).toMatchObject({ search_volume: 5 });
  });

  const creds = async () => ({ login: "l", password: "p" });
  const answer = (task: object) => (async () => new Response(JSON.stringify({ status_code: 20000, tasks: [task] }))) as unknown as typeof fetch;
  it("live: a task code other than 20000 throws, so a failed task is never an empty success", async () => {
    const t = liveKeywordTransport({ fetch: answer({ status_code: 40501, status_message: "Invalid Field: location_name", cost: 0 }), credentials: creds });
    await expect(t.adsVolume({ keywords: ["a"], locationName: "Nowhere", languageCode: "en" })).rejects.toBeInstanceOf(DfsTaskError);
    await expect(t.labs("ideas", { seed: "x", locationCode: 1, languageCode: "en", limit: 5 })).rejects.toBeInstanceOf(DfsTaskError);
    const none = liveKeywordTransport({ fetch: (async () => new Response(JSON.stringify({ status_code: 20000, tasks: [] }))) as unknown as typeof fetch, credentials: creds });
    await expect(none.labs("ideas", { seed: "x", locationCode: 1, languageCode: "en", limit: 5 })).rejects.toBeInstanceOf(DfsTaskError);
  });
  it("live: null or empty items are an empty answer, and a missing cost counts the configured price", async () => {
    const t = liveKeywordTransport({ fetch: answer({ status_code: 20000, result: [{ items: null }] }), credentials: creds });
    const r = await t.labs("ideas", { seed: "x", locationCode: 1, languageCode: "en", limit: 5 });
    expect(r.items).toEqual([]);
    expect(r.costUsd).toBeCloseTo(SEO_PRICES.labs.perTaskUsd, 6);
    const ads = liveKeywordTransport({ fetch: answer({ status_code: 20000, result: null }), credentials: creds });
    expect(await ads.adsVolume({ keywords: ["a"], locationName: "X", languageCode: "en" })).toEqual({ items: [], costUsd: SEO_PRICES.googleAdsLive.perTaskUsd });
    const some = liveKeywordTransport({ fetch: answer({ status_code: 20000, result: [{ items: [{ keyword: "a" }, { keyword: "b" }] }] }), credentials: creds });
    expect((await some.labs("ideas", { seed: "x", locationCode: 1, languageCode: "en", limit: 5 })).costUsd).toBeCloseTo(SEO_PRICES.labs.perTaskUsd + 2 * SEO_PRICES.labs.perRowUsd, 6);
  });
});
