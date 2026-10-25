import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GEOGRID_SERP, taskPriceUsd } from "../../config/geogrid";
import { createDataForSeoDriver, parseSerpTaskGet } from "./dataforseo";
import { DfsNotReadyError } from "./errors";
import { fixtureDataForSeoTransport, serpFixtureItems, type DfsTaskGetResponse } from "./fixtures";
import { normalizeDomain, resolvePointResult } from "./index";
import { liveDataForSeoTransport } from "./live-dataforseo";

const response = (items: unknown[], status = 20000): DfsTaskGetResponse =>
  ({
    version: "x",
    status_code: 20000,
    status_message: "Ok.",
    tasks_count: 1,
    tasks: [{ id: "t1", status_code: status, status_message: "m", cost: 0, result: [{ keyword: "k", type: "organic", items_count: items.length, items }] }],
  }) as unknown as DfsTaskGetResponse;

// Shapes copied from https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/ (verified 2026-10-24).
const SAMPLE = [
  { type: "paid", rank_group: 1, rank_absolute: 1 },
  { type: "local_pack", rank_group: 1, rank_absolute: 2, title: "Other Dental", domain: "other.example", url: null, cid: "111", rating: { value: 4.5, votes_count: 30, rating_max: 5, rating_type: "Max5" } },
  { type: "local_pack", rank_group: 2, rank_absolute: 3, title: "Acme Dental", domain: "www.acme.example", url: null, cid: "222", rating: null },
  { type: "organic", rank_group: 1, rank_absolute: 4, title: "A", domain: "a.example", url: "https://a.example/" },
  { type: "organic", rank_group: 2, rank_absolute: 5, title: "Acme", domain: "acme.example", url: "https://acme.example/dentist" },
  { type: "organic", rank_group: 3, rank_absolute: 6, title: "Acme again", domain: "acme.example", url: "https://acme.example/more" },
];

describe("K4: Google Organic results", () => {
  it("parses local pack and organic items, ignores other item types", () => {
    const r = parseSerpTaskGet(response(SAMPLE));
    expect(r.map((x) => [x.kind, x.rank])).toEqual([["local_pack", 1], ["local_pack", 2], ["organic", 1], ["organic", 2], ["organic", 3]]);
    expect(r[1]).toMatchObject({ title: "Acme Dental", cid: "222", rating: null });
  });

  it("canary: the extractor finds the fixture's items (a parser that finds nothing fails here)", () => {
    const items = serpFixtureItems({ keyword: "dentist", target: { name: "Acme", placeId: null, domain: "acme.example" } });
    const r = parseSerpTaskGet(response(items));
    expect(r.filter((x) => x.kind === "local_pack")).toHaveLength(3);
    expect(r.filter((x) => x.kind === "organic")).toHaveLength(20);
  });

  it("throws not-ready on 40602 and an error on other failures", () => {
    expect(() => parseSerpTaskGet(response([], 40602))).toThrow(DfsNotReadyError);
    expect(() => parseSerpTaskGet(response([], 50000))).toThrow(/50000/);
  });

  it("finds the target: local pack by domain or title, organic by domain, the first organic hit wins", () => {
    const results = parseSerpTaskGet(response(SAMPLE));
    const out = resolvePointResult(results, { name: "Acme Dental", placeId: null, domain: "https://www.ACME.example/x" });
    expect(out).toMatchObject({ rank: 2, top3: true, organicRank: 2, organicUrl: "https://acme.example/dentist" });
    expect(out.competitors.map((c) => c.isTarget)).toEqual([false, true]);
    const none = resolvePointResult(results, { name: "Nobody", placeId: null, domain: "nobody.example" });
    expect(none).toMatchObject({ rank: null, top3: false, organicRank: null, organicUrl: null });
  });

  it("without a website the organic rank is null; a Maps result has no organic fields at all", () => {
    expect(resolvePointResult(parseSerpTaskGet(response(SAMPLE)), { name: "Acme Dental", placeId: null })).toMatchObject({ rank: 2, organicRank: null });
    const maps = resolvePointResult([{ rank: 1, rankAbsolute: 1, title: "Acme", placeId: "p", cid: null, rating: null }], { name: "Acme", placeId: "p" });
    expect("organicRank" in maps).toBe(false);
  });

  it("normalizes domains", () => {
    expect(normalizeDomain(" HTTPS://www.Example.com/path?q=1 ")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  it("one task costs two SERP pages at the speed's price", () => {
    expect(GEOGRID_SERP.pages * 10).toBe(GEOGRID_SERP.depth);
    expect(taskPriceUsd("dataforseo_serp", "standard")).toBeCloseTo(0.0012, 8);
    expect(taskPriceUsd("dataforseo_serp", "fast")).toBeCloseTo(0.0024, 8);
    expect(createDataForSeoDriver(fixtureDataForSeoTransport(), "standard", "organic").estimateCost(1, 3)).toBeCloseTo(0.0036, 8);
  });
});

describe("K4: the live transport talks to the Google Organic endpoints", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; body: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status_code: 20000, tasks_count: 1, cost: 0.0012, tasks: [{ id: "abc", status_code: 20100, status_message: "Task Created.", cost: 0.0012, result: null }] }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("posts organic tasks with a coordinate and radius, depth 20 and no search_this_area; gets from task_get/advanced", async () => {
    const driver = createDataForSeoDriver(
      liveDataForSeoTransport({ baseUrl: base, credentials: async () => ({ login: "a@b.test", password: "pw" }) }),
      "fast",
      "organic",
    );
    const out = await driver.submit([{ row: 0, col: 0, lat: 29.4241, lng: -98.4936, pingbackUrl: "https://w.test/webhooks/dataforseo?id=$id&token=t" }], "emergency dentist", { name: "Acme", placeId: null, domain: "acme.example" });
    expect(out.refs).toEqual([{ row: 0, col: 0, ref: "abc" }]);
    expect(out.providerCostUsd).toBeCloseTo(0.0012, 8);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v3/serp/google/organic/task_post" });
    const sent = JSON.parse(seen[0]!.body)[0];
    expect(sent).toMatchObject({
      keyword: "emergency dentist",
      location_coordinate: `29.4241000,-98.4936000,${GEOGRID_SERP.coordinateRadius}`,
      language_code: "en",
      device: "mobile",
      depth: 20,
      priority: 2,
    });
    expect(sent).not.toHaveProperty("search_this_area");
    expect(JSON.parse(sent.tag).d).toBe("acme.example");
    await expect(driver.collect({ row: 0, col: 0, ref: "abc" })).rejects.toThrow();
    expect(seen[1]).toMatchObject({ method: "GET", url: "/v3/serp/google/organic/task_get/advanced/abc" });
  });
});
