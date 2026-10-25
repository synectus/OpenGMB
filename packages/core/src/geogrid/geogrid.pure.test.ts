import { describe, expect, it } from "vitest";
import {
  DATAFORSEO_ENDPOINTS,
  DFS_ERROR_CLASSES,
  GEOGRID_DEFAULTS,
  GEOGRID_DRIVER_LABELS,
  GEOGRID_PLATFORM_CAP,
  GEOGRID_PRICING,
  GEOGRID_SPEEDS,
} from "../config/geogrid";
import { PLACES_ENDPOINTS, PLACES_PRICING } from "../config/places";
import { CoreError } from "../errors";
import {
  averageRank,
  competitorTable,
  foundShare,
  runHistory,
  top3Share,
  type Competitor,
} from "./analytics";
import { estimateCostUsd, monthBounds, roundUpUsd } from "./cost";
import {
  createDataForSeoDriver,
  DfsAccountError,
  DfsHttpError,
  DfsNotReadyError,
  createDriverRegistry,
  createPlacesRelevanceDriver,
  fixtureDataForSeoTransport,
  fixturePlacesTransport,
  type DataForSeoTransport,
  parseDataForSeoTaskGet,
  resolvePointResult,
} from "./drivers";
import { buildGrid, haversineM, isValidGridSize } from "./math";
import { GRID_SCHEDULE_CRON } from "./run";
import { GRID_SCHEDULE_HOUR_UTC, isDue, nextScheduledRunAt } from "./schedule";

const C = { lat: 51.5074, lng: -0.1278 };

describe("grid math", () => {
  it("accepts only odd sizes 3..13", () => {
    const ok = [3, 5, 7, 9, 11, 13];
    for (let n = 0; n <= 15; n++) expect(isValidGridSize(n)).toBe(ok.includes(n));
    expect(() => buildGrid({ ...C, size: 4, radiusM: 1000 })).toThrow(CoreError);
    expect(() => buildGrid({ ...C, size: 15, radiusM: 1000 })).toThrow(CoreError);
  });

  it.each([3, 5, 13])("builds %i x %i points centred on the location", (n) => {
    const g = buildGrid({ ...C, size: n, radiusM: 5000 });
    expect(g).toHaveLength(n * n);
    const mid = (n - 1) / 2;
    const centre = g.find((p) => p.row === mid && p.col === mid)!;
    expect(centre.lat).toBeCloseTo(C.lat, 9);
    expect(centre.lng).toBeCloseTo(C.lng, 9);
    // Row 0 is north, col 0 is west.
    expect(g.find((p) => p.row === 0 && p.col === 0)!.lat).toBeGreaterThan(C.lat);
    expect(g.find((p) => p.row === 0 && p.col === 0)!.lng).toBeLessThan(C.lng);
  });

  it("puts the edge at the radius and adjacent points at radius / half apart (haversine)", () => {
    const n = 7;
    const radius = 6000;
    const g = buildGrid({ ...C, size: n, radiusM: radius });
    const at = (r: number, c: number) => g.find((p) => p.row === r && p.col === c)!;
    const mid = 3;
    expect(haversineM(at(mid, mid), at(0, mid))).toBeCloseTo(radius, -1);
    expect(haversineM(at(mid, mid), at(mid, 6))).toBeGreaterThan(radius * 0.995);
    expect(haversineM(at(mid, mid), at(mid, 6))).toBeLessThan(radius * 1.005);
    const step = radius / 3;
    expect(Math.abs(haversineM(at(2, 2), at(2, 3)) - step) / step).toBeLessThan(0.005);
    expect(Math.abs(haversineM(at(2, 2), at(3, 2)) - step) / step).toBeLessThan(0.005);
  });

  it("rejects bad radius and coordinates", () => {
    expect(() => buildGrid({ ...C, size: 3, radiusM: 5 })).toThrow(CoreError);
    expect(() => buildGrid({ ...C, size: 3, radiusM: 1e7 })).toThrow(CoreError);
    expect(() => buildGrid({ lat: 91, lng: 0, size: 3, radiusM: 1000 })).toThrow(CoreError);
  });
});

describe("cost", () => {
  it("is points x keywords x price x (1 + markup)", () => {
    const unit = GEOGRID_PRICING.dataforseo_standard.perTaskUsd;
    const est = estimateCostUsd({
      driverId: "dataforseo_standard",
      points: 49,
      keywordCount: 2,
      markupPercent: 28,
    });
    expect(est).toBe(roundUpUsd(49 * 2 * unit * 1.28));
    expect(est).toBeGreaterThanOrEqual(49 * 2 * unit * 1.28);
    expect(est).toBeLessThan(49 * 2 * unit * 1.28 + 0.0001);
  });
  it("fast uses the higher unit price, standard is unchanged, and the relevance check stays free", () => {
    const base = { points: 49, keywordCount: 2, markupPercent: 28 };
    const std = estimateCostUsd({ ...base, driverId: "dataforseo_standard" });
    expect(estimateCostUsd({ ...base, driverId: "dataforseo_standard", speed: "standard" })).toBe(std);
    expect(estimateCostUsd({ ...base, driverId: "dataforseo_standard", speed: "fast" })).toBe(
      roundUpUsd(49 * 2 * GEOGRID_SPEEDS.fast.perTaskUsd * 1.28),
    );
    expect(GEOGRID_SPEEDS.fast.perTaskUsd).toBe(2 * GEOGRID_SPEEDS.standard.perTaskUsd);
    expect(GEOGRID_SPEEDS.standard.perTaskUsd).toBe(GEOGRID_PRICING.dataforseo_standard.perTaskUsd);
    expect(estimateCostUsd({ ...base, driverId: "places_relevance", speed: "fast" })).toBe(0);
  });
  it("relevance check is free", () => {
    expect(
      estimateCostUsd({
        driverId: "places_relevance",
        points: 169,
        keywordCount: 5,
        markupPercent: 28,
      }),
    ).toBe(0);
  });
  it("rounds up without float noise", () => {
    expect(roundUpUsd(0.3)).toBe(0.3);
    expect(roundUpUsd(0.30001)).toBe(0.3001);
  });
  it("month bounds are UTC calendar months", () => {
    const { start, end } = monthBounds(new Date("2026-12-31T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("pricing config carries source and verified-on", () => {
    for (const p of Object.values(GEOGRID_PRICING)) {
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it("every external fact carries a source URL and an ISO verified-on date", () => {
    const facts: Record<string, { sourceUrl: string; verifiedOn: string }> = {
      "GEOGRID_PRICING.dataforseo_standard": GEOGRID_PRICING.dataforseo_standard,
      "GEOGRID_PRICING.places_relevance": GEOGRID_PRICING.places_relevance,
      "GEOGRID_SPEEDS.standard": GEOGRID_SPEEDS.standard,
      "GEOGRID_SPEEDS.fast": GEOGRID_SPEEDS.fast,
      DATAFORSEO_ENDPOINTS,
      DFS_ERROR_CLASSES,
      PLACES_ENDPOINTS,
      ...Object.fromEntries(Object.entries(PLACES_PRICING).map(([k, v]) => [`PLACES_PRICING.${k}`, v])),
    };
    const names = Object.keys(facts);
    console.log(`${names.length} facts checked`);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain("GEOGRID_PRICING.dataforseo_standard"); // canary
    for (const f of Object.values(facts)) {
      expect(f.sourceUrl).toMatch(/^https:\/\//);
      expect(f.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(GEOGRID_PRICING.places_relevance.status).toBe("verified");
    expect(GEOGRID_PLATFORM_CAP.decidedBy).toBeTruthy();
    expect(GEOGRID_PLATFORM_CAP.decidedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("analytics", () => {
  const pts = [{ rank: 1 }, { rank: 3 }, { rank: 10 }, { rank: null }];
  it("average rank counts not-found as 21", () => {
    expect(averageRank(pts)).toBe((1 + 3 + 10 + GEOGRID_DEFAULTS.notFoundRank) / 4);
    expect(GEOGRID_DEFAULTS.notFoundRank).toBe(21);
    expect(averageRank([{ rank: null }])).toBe(21);
    expect(averageRank([])).toBeNull();
  });
  it("top-3 and found shares", () => {
    expect(top3Share(pts)).toBe(0.5);
    expect(foundShare(pts)).toBe(0.75);
    expect(top3Share([])).toBeNull();
  });
  it("history is oldest first with a summary per run", () => {
    const h = runHistory([
      { id: "b", keyword: "k", finishedAt: new Date("2026-02-01Z"), points: [{ rank: 2 }] },
      { id: "a", keyword: "k", finishedAt: new Date("2026-01-01Z"), points: [{ rank: null }] },
    ]);
    expect(h.map((x) => x.runId)).toEqual(["a", "b"]);
    expect(h[0]!.averageRank).toBe(21);
    expect(h[1]!.top3Share).toBe(1);
  });
  it("competitor table aggregates, skips the target, orders by appearances", () => {
    const c = (rank: number, title: string, placeId: string, isTarget = false): Competitor => ({
      rank,
      title,
      placeId,
      rating: null,
      isTarget,
    });
    const t = competitorTable([
      { competitors: [c(1, "Me", "me", true), c(2, "Alpha", "a"), c(3, "Beta", "b")] },
      { competitors: [c(1, "Alpha", "a"), c(2, "Me", "me", true)] },
      { competitors: [c(5, "Alpha", "a")] },
    ]);
    expect(t.map((r) => r.business)).toEqual(["Alpha", "Beta"]);
    expect(t[0]).toMatchObject({ appearances: 3, bestRank: 1 });
    expect(t[0]!.averageRank).toBeCloseTo(2.67, 2);
    expect(t[1]).toMatchObject({ appearances: 1, averageRank: 3, bestRank: 3 });
  });
});

describe("schedule", () => {
  const now = new Date("2026-03-10T05:00:00Z");
  it("manual is never due; never-run is due", () => {
    expect(isDue("manual", null, now)).toBe(false);
    expect(isDue("daily", null, now)).toBe(true);
  });
  it("daily, weekly, monthly intervals (with tolerance)", () => {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const day = 24 * 3600_000;
    expect(isDue("daily", ago(day - 600_000), now)).toBe(true);
    expect(isDue("daily", ago(day / 2), now)).toBe(false);
    expect(isDue("weekly", ago(6 * day), now)).toBe(false);
    expect(isDue("weekly", ago(7 * day), now)).toBe(true);
    expect(isDue("monthly", new Date("2026-02-12T05:00:00Z"), now)).toBe(false);
    expect(isDue("monthly", new Date("2026-02-10T05:00:00Z"), now)).toBe(true);
  });
});

describe("drivers", () => {
  const points = buildGrid({ ...C, size: 3, radiusM: 3000 }).map((p) => ({
    ...p,
    pingbackUrl: `https://w.test/webhooks/dataforseo?id=$id&token=t${p.row}${p.col}`,
  }));
  const target = { name: "Acme Dental", placeId: null };

  it("dataforseo: submit -> task refs, collect parses tasks[].result[].items[]", async () => {
    const d = createDataForSeoDriver();
    expect(d.isMapsRank).toBe(true);
    expect(d.completion).toBe("pingback");
    const { refs, failed, providerCostUsd } = await d.submit(points, "dentist", target);
    expect(failed).toEqual([]);
    expect(providerCostUsd).toBeCloseTo(9 * 0.0006, 10);
    expect(refs).toHaveLength(9);
    expect(new Set(refs.map((r) => r.ref)).size).toBe(9);
    const res = await d.collect(refs[4]!);
    expect(res.length).toBe(20);
    expect(res[0]).toMatchObject({ rank: 1, rankAbsolute: 1 });
    expect(res.map((r) => r.rank)).toEqual(res.map((_, i) => i + 1));
    expect(res.every((r) => r.title && r.placeId && r.rating !== null)).toBe(true);
    // Deterministic across instances (a different process could collect).
    const again = await createDataForSeoDriver().collect(refs[4]!);
    expect(again).toEqual(res);
  });

  it("dataforseo: parser rejects a non-success task", async () => {
    const t = fixtureDataForSeoTransport();
    expect(() => parseDataForSeoTaskGet({} as never)).toThrow();
    const notFound = await t.taskGet("nope");
    expect(() => parseDataForSeoTaskGet(notFound)).toThrow(/40401/);
  });

  it("dataforseo: estimateCost uses the configured per-task price", () => {
    const d = createDataForSeoDriver();
    expect(d.estimateCost(100, 2)).toBe(
      roundUpUsd(200 * GEOGRID_PRICING.dataforseo_standard.perTaskUsd),
    );
  });

  it("dataforseo task_post carries the pingback url per point", async () => {
    const seen: string[] = [];
    const base = fixtureDataForSeoTransport();
    const d = createDataForSeoDriver({
      taskPost: async (items) => {
        seen.push(...items.map((i) => i.pingback_url ?? ""));
        return base.taskPost(items);
      },
      taskGet: base.taskGet,
    });
    await d.submit(points, "dentist", target);
    expect(seen).toEqual(points.map((p) => p.pingbackUrl));
  });

  it("task_post sends priority 2 for fast and no priority field for standard", async () => {
    const seen = async (speed?: "standard" | "fast") => {
      const items: { priority?: number; search_this_area?: boolean }[] = [];
      const base = fixtureDataForSeoTransport();
      const d = createDataForSeoDriver(
        {
          taskPost: async (it) => {
            items.push(...it);
            return base.taskPost(it);
          },
          taskGet: base.taskGet,
        },
        speed,
      );
      await d.submit(points, "dentist", target);
      return items;
    };
    const fast = await seen("fast");
    expect(fast.length).toBe(points.length);
    expect(fast.every((i) => i.priority === 2)).toBe(true);
    expect(fast.every((i) => i.search_this_area === false)).toBe(true);
    for (const speed of [undefined, "standard" as const]) {
      const std = await seen(speed);
      expect(std.length).toBe(points.length);
      expect(std.some((i) => "priority" in i)).toBe(false);
      expect(std.every((i) => i.search_this_area === false)).toBe(true);
    }
  });
  it("driver estimate follows the speed", () => {
    expect(createDataForSeoDriver(undefined, "fast").estimateCost(9, 1)).toBe(roundUpUsd(9 * 0.0012));
    expect(createDataForSeoDriver().estimateCost(9, 1)).toBe(roundUpUsd(9 * 0.0006));
  });

  describe("dataforseo submit limits and partial failure", () => {
    const grid = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        row: Math.floor(i / 13),
        col: i % 13,
        lat: C.lat + i * 1e-4,
        lng: C.lng,
        pingbackUrl: null,
      }));
    const item = { keyword: "k", location_coordinate: `${C.lat},${C.lng},13z`, language_code: "en", device: "mobile" as const, depth: 20 };

    it("(a) the fixture refuses 101 tasks with 40006 and creates none", async () => {
      const res = await fixtureDataForSeoTransport().taskPost(Array.from({ length: 101 }, () => ({ ...item, tag: JSON.stringify({ c: [0, 0], n: "a", p: null }) })));
      expect(res.status_code).toBe(40006);
      expect(res.tasks).toHaveLength(0);
    });

    it("(b) the fixture rejects a tag over 255 characters with item status 40501", async () => {
      const res = await fixtureDataForSeoTransport().taskPost([{ ...item, tag: "x".repeat(256) }]);
      expect(res.tasks[0]!.status_code).toBe(40501);
      const ok = await fixtureDataForSeoTransport().taskPost([{ ...item, tag: JSON.stringify({ c: [0, 0], n: "a", p: null }) }]);
      expect(ok.tasks[0]!.status_code).toBe(20100);
    });

    it("(c) 169 points go out as two posts (100 and 69); cost is the sum of both", async () => {
      const sizes: number[] = [];
      const base = fixtureDataForSeoTransport();
      const d = createDataForSeoDriver({
        taskGet: base.taskGet,
        taskPost: async (items) => {
          sizes.push(items.length);
          const r = await base.taskPost(items);
          return { ...r, cost: items.length * 0.001 };
        },
      });
      const out = await d.submit(grid(169), "dentist", target);
      expect(sizes).toEqual([100, 69]);
      expect(out.refs).toHaveLength(169);
      expect(out.failed).toEqual([]);
      expect(out.providerCostUsd).toBeCloseTo(0.169, 10);
    });

    it("(d) a 400-character target name still gives tags of at most 255 characters", async () => {
      const tags: string[] = [];
      const base = fixtureDataForSeoTransport();
      const d = createDataForSeoDriver({
        taskGet: base.taskGet,
        taskPost: async (items) => {
          tags.push(...items.map((i) => i.tag ?? ""));
          return base.taskPost(items);
        },
      });
      const out = await d.submit(grid(3), "dentist", { name: "N".repeat(400), placeId: "ChIJx" });
      expect(tags).toHaveLength(3);
      expect(tags.every((t) => t.length <= 255 && t.length > 0)).toBe(true);
      expect(JSON.parse(tags[0]!).p).toBe("ChIJx");
      expect(out.refs).toHaveLength(3);
    });

    it("(e) chunk 1 created and chunk 2 answers HTTP 500: the 100 are kept, the 69 are failed", async () => {
      const base = fixtureDataForSeoTransport();
      let call = 0;
      const d = createDataForSeoDriver({
        taskGet: base.taskGet,
        taskPost: async (items) => {
          if (++call === 2) throw new DfsHttpError(500);
          const r = await base.taskPost(items);
          return { ...r, cost: 0.06 };
        },
      });
      const out = await d.submit(grid(169), "dentist", target);
      expect(out.refs).toHaveLength(100);
      expect(out.failed).toHaveLength(69);
      expect(out.failed[0]!.error).toBe("task_post_failed: HTTP 500");
      expect(out.providerCostUsd).toBeCloseTo(0.06, 10);
    });

    it("(f) an item 40501 inside a 20000 response lands in failed; the others in refs", async () => {
      const base = fixtureDataForSeoTransport();
      const d = createDataForSeoDriver({
        taskGet: base.taskGet,
        taskPost: async (items) => {
          const r = await base.taskPost(items);
          r.tasks[1] = { id: "", status_code: 40501, status_message: "Invalid Field: 'tag'.", cost: 0, result: null };
          return r;
        },
      });
      const out = await d.submit(grid(3), "dentist", target);
      expect(out.refs).toHaveLength(2);
      expect(out.failed).toEqual([{ row: 0, col: 1, error: "task_post_item: 40501 Invalid Field: 'tag'." }]);
    });

    it("an account error on the first chunk is thrown (nothing was bought); on a later chunk it stops the rest", async () => {
      const base = fixtureDataForSeoTransport();
      const first = createDataForSeoDriver({ taskGet: base.taskGet, taskPost: async () => { throw new DfsAccountError(40210, "Insufficient funds"); } });
      await expect(first.submit(grid(3), "dentist", target)).rejects.toBeInstanceOf(DfsAccountError);
      let call = 0;
      const later = createDataForSeoDriver({
        taskGet: base.taskGet,
        taskPost: async (items) => {
          if (++call === 2) throw new DfsAccountError(40210, "Insufficient funds");
          return base.taskPost(items);
        },
      });
      const out = await later.submit(grid(250), "dentist", target);
      expect(call).toBe(2); // the third chunk was not attempted
      expect(out.refs).toHaveLength(100);
      expect(out.failed).toHaveLength(150);
      expect(out.accountError?.code).toBe(40210);
    });

    it("task_get 40601/40602 is not-ready, not a failure", () => {
      const res = (code: number) => ({ tasks: [{ id: "x", status_code: code, status_message: "m", cost: 0, result: null }] }) as never;
      expect(() => parseDataForSeoTaskGet(res(40602))).toThrow(DfsNotReadyError);
      expect(() => parseDataForSeoTaskGet(res(40601))).toThrow(DfsNotReadyError);
      expect(() => parseDataForSeoTaskGet(res(40401))).not.toThrow(DfsNotReadyError);
    });
  });

  it("places: labelled not Maps rank, free, needs place id, returns ids only", async () => {
    const d = createPlacesRelevanceDriver();
    expect(d.isMapsRank).toBe(false);
    expect(d.label).toBe("Relevance check (not Maps rank)");
    expect(d.estimateCost(169, 5)).toBe(0);
    await expect(d.submit(points, "dentist", target)).rejects.toThrow(CoreError);
    const { refs } = await d.submit(points, "dentist", { name: "Acme", placeId: "ChIJme" });
    const res = await d.collect(refs[0]!);
    expect(res.length).toBe(20);
    expect(res.every((r) => r.placeId && r.title === null)).toBe(true);
    await expect(d.collect(refs[0]!)).rejects.toThrow(); // consumed
  });

  describe("registry: live or fixture per lookup", () => {
    const tagged = (name: string): DataForSeoTransport => {
      const base = fixtureDataForSeoTransport();
      return { ...base, checkCredentials: async () => ({ ok: true, message: name }) };
    };
    const pts = points.slice(0, 1);
    // Which transport a driver is wired to, observed through its submit.
    const wiredTo = async (d: ReturnType<ReturnType<typeof createDriverRegistry>>) =>
      (await d.submit(pts, "k", target)).refs[0]!.ref.startsWith("fx-") ? "fixture-ids" : "other";

    it("(a) a fixture source uses the fixture and never builds a live transport", () => {
      let built = 0;
      const reg = createDriverRegistry({ source: () => "fixture", liveDataForSeo: () => { built++; return tagged("live"); } });
      reg("dataforseo_standard");
      expect(built).toBe(0);
      expect(reg.dataSource("dataforseo_standard")).toBe("fixture");
    });

    it("(b) a live source uses the live transport; the source is read on every lookup", async () => {
      let src: "fixture" | "live" = "fixture";
      const posts: string[] = [];
      const live: DataForSeoTransport = {
        taskGet: async () => { throw new Error("x"); },
        taskPost: async (items) => {
          posts.push("live");
          return { version: "v", status_code: 20000, status_message: "Ok.", cost: 0.0006 * items.length, tasks_count: items.length,
            tasks: items.map((_, i) => ({ id: `live-${i}`, status_code: 20100, status_message: "Task Created.", cost: 0.0006, result: null })) };
        },
      };
      const reg = createDriverRegistry({ source: () => src, liveDataForSeo: () => live });
      expect(await wiredTo(reg("dataforseo_standard"))).toBe("fixture-ids");
      src = "live"; // a key was entered while the process runs
      expect(await wiredTo(reg("dataforseo_standard"))).toBe("other");
      expect(posts).toEqual(["live"]);
      src = "fixture"; // and cleared again
      expect(await wiredTo(reg("dataforseo_standard"))).toBe("fixture-ids");
    });

    it("(c) lookup with a run's own dataSource wins over the current source", async () => {
      const reg = createDriverRegistry({ source: () => "live", liveDataForSeo: () => { throw new Error("must not be built"); } });
      expect(await wiredTo(reg("dataforseo_standard", { dataSource: "fixture" }))).toBe("fixture-ids");
    });

    it("(c3) the host comes from the run: sandbox and live runs keep their own host whatever the env says now", () => {
      const hosts: string[] = [];
      let src: "live" | "sandbox" = "live";
      const reg = createDriverRegistry({ source: () => src, liveDataForSeo: (base) => { hosts.push(base); return tagged(base); } });
      reg("dataforseo_standard", { dataSource: "sandbox" });
      src = "sandbox"; // env flipped between submit and collect
      reg("dataforseo_standard", { dataSource: "live" });
      expect(hosts).toEqual(["https://sandbox.dataforseo.com", "https://api.dataforseo.com"]);
    });

    it("(d) BYO on a live source uses the live BYO transport with those credentials and the run's host", async () => {
      const seen: { login: string; base: string }[] = [];
      const reg = createDriverRegistry({
        source: () => "live",
        liveByoDataForSeo: (creds, base) => { seen.push({ login: creds.login, base }); return tagged("byo"); },
      });
      reg("dataforseo_standard", { credentials: { login: "me@x.test", password: "p" }, dataSource: "live" });
      expect(seen).toEqual([{ login: "me@x.test", base: "https://api.dataforseo.com" }]);
    });

    it("(e) BYO with a fixture dataSource uses the fixture BYO transport", async () => {
      const reg = createDriverRegistry({ source: () => "live", liveByoDataForSeo: () => { throw new Error("must not be built"); } });
      const d = reg("dataforseo_standard", { credentials: { login: "a@b.test", password: "p" }, dataSource: "fixture" });
      expect(await wiredTo(d)).toBe("fixture-ids");
    });

    it("(f) checkDataForSeoCredentials uses the live BYO transport unless the source is fixture", async () => {
      const live = createDriverRegistry({ source: () => "live", liveByoDataForSeo: () => tagged("live-check") });
      expect((await live.checkDataForSeoCredentials({ login: "a", password: "b" })).message).toBe("live-check");
      const fx = createDriverRegistry({ source: () => "fixture", liveByoDataForSeo: () => tagged("live-check") });
      expect((await fx.checkDataForSeoCredentials({ login: "a", password: "b" })).message).toBe("Ok. (fixture)");
    });

    it("the relevance check follows the Places source", () => {
      let src: "live" | "fixture" = "fixture";
      let built = 0;
      const reg = createDriverRegistry({ placesSource: () => src, livePlaces: () => { built++; return fixturePlacesTransport(); } });
      expect(reg.dataSource("places_relevance")).toBe("fixture");
      reg("places_relevance");
      expect(built).toBe(0);
      src = "live";
      expect(reg.dataSource("places_relevance")).toBe("live");
      expect(reg("places_relevance")).toBe(reg("places_relevance")); // cached: it holds pending answers
      expect(built).toBe(1);
    });
  });

  it("registry rejects unknown drivers", () => {
    expect(() => createDriverRegistry()("nope")).toThrow(CoreError);
  });

  it("resolvePointResult matches by place id, else by title; null when absent", () => {
    const results = [
      { rank: 1, rankAbsolute: 1, title: "X", placeId: "x", cid: null, rating: 4 },
      { rank: 2, rankAbsolute: 2, title: "Acme Dental", placeId: "me", cid: null, rating: 5 },
    ];
    expect(resolvePointResult(results, { name: "acme dental", placeId: null })).toMatchObject({
      rank: 2,
      top3: true,
    });
    expect(resolvePointResult(results, { name: "zzz", placeId: "x" }).rank).toBe(1);
    const miss = resolvePointResult(results, { name: "Nope", placeId: null });
    expect(miss).toMatchObject({ rank: null, top3: false });
    expect(miss.competitors.every((c) => !c.isTarget)).toBe(true);
    expect(
      resolvePointResult(results, { name: "Acme Dental", placeId: null }).competitors[1]!.isTarget,
    ).toBe(true);
    const deep = [{ ...results[0]!, rank: 7, placeId: "me" }];
    expect(resolvePointResult(deep, { name: "q", placeId: "me" })).toMatchObject({
      rank: 7,
      top3: false,
    });
  });
});

describe("rank map upgrades (plan 4B1)", () => {
  it("no driver label contains an em dash; the relevance check reads like the canvas", () => {
    expect(GEOGRID_DRIVER_LABELS.places_relevance).toBe("Relevance check (not Maps rank)");
    expect(Object.values(GEOGRID_DRIVER_LABELS).some((l) => l.includes("—"))).toBe(false);
  });

  it("the Maps-rank label names no queue: the queue is per run (speed), so a Fast run is never called Standard", () => {
    expect(GEOGRID_DRIVER_LABELS.dataforseo_standard).toBe("DataForSEO Google Maps");
    expect(GEOGRID_DEFAULTS.mapsZoom).toBe(13);
  });

  it("the schedule hour matches the cron the worker registers (canary)", () => {
    expect(GRID_SCHEDULE_CRON).toBe(`0 ${GRID_SCHEDULE_HOUR_UTC} * * *`);
  });

  it("nextScheduledRunAt follows the daily 05:00 UTC tick and the one-hour tolerance", () => {
    const now = new Date("2026-10-18T10:00:00Z");
    const at = (s: Parameters<typeof nextScheduledRunAt>[0], last: string | null, n = now) =>
      nextScheduledRunAt(s, last ? new Date(last) : null, n)?.toISOString() ?? null;
    expect(at("manual", null)).toBeNull();
    expect(at("manual", "2026-10-01T05:00:00Z")).toBeNull();
    // Never scheduled: the next tick from now.
    expect(at("weekly", null)).toBe("2026-10-19T05:00:00.000Z");
    expect(at("daily", null, new Date("2026-10-18T04:30:00Z"))).toBe("2026-10-18T05:00:00.000Z");
    // Due at last + period - 1 h, picked up by the first tick at or after that.
    expect(at("weekly", "2026-10-14T05:00:00Z")).toBe("2026-10-21T05:00:00.000Z");
    expect(at("monthly", "2026-09-30T05:00:00Z")).toBe("2026-10-30T05:00:00.000Z");
    // Overdue (the worker was down): the next tick from now.
    expect(at("daily", "2026-10-10T05:00:00Z")).toBe("2026-10-19T05:00:00.000Z");
  });

  it("competitor table can put the target first and carries address, rating and reviews", () => {
    const c = (
      rank: number,
      title: string,
      placeId: string,
      extra: Partial<Competitor> = {},
    ): Competitor => ({ rank, title, placeId, rating: null, isTarget: false, ...extra });
    const pts = [
      {
        competitors: [
          c(1, "Me", "me", { isTarget: true, address: "1 Main St", rating: 4.6, reviewCount: 212 }),
          c(2, "Alpha", "a", { address: "2 Oak Ave", rating: 4.3, reviewCount: 88 }),
        ],
      },
      { competitors: [c(1, "Alpha", "a"), c(3, "Me", "me", { isTarget: true })] },
      { competitors: [c(2, "Alpha", "a")] },
    ];
    expect(competitorTable(pts).map((r) => r.business)).toEqual(["Alpha"]);
    const t = competitorTable(pts, { includeTarget: true });
    expect(t.map((r) => [r.business, r.isTarget])).toEqual([
      ["Me", true],
      ["Alpha", false],
    ]);
    expect(t[0]).toMatchObject({
      appearances: 2,
      averageRank: 2,
      bestRank: 1,
      address: "1 Main St",
      rating: 4.6,
      reviewCount: 212,
    });
    expect(t[1]).toMatchObject({ appearances: 3, address: "2 Oak Ave", rating: 4.3, reviewCount: 88 });
    // Rows stored before this change have no address or reviewCount.
    expect(competitorTable([{ competitors: [c(4, "Old", "o")] }])[0]).toMatchObject({
      address: null,
      rating: null,
      reviewCount: null,
      isTarget: false,
    });
  });

  it("DataForSEO results keep the address and the review count", async () => {
    const res = parseDataForSeoTaskGet({
      version: "0.1",
      status_code: 20000,
      status_message: "Ok.",
      tasks_count: 1,
      tasks: [
        {
          id: "t1",
          status_code: 20000,
          status_message: "Ok.",
          cost: 0.0006,
          result: [
            {
              keyword: "k",
              type: "maps",
              items_count: 1,
              items: [
                {
                  type: "maps_search",
                  rank_group: 1,
                  rank_absolute: 1,
                  title: "Alpha",
                  domain: null,
                  place_id: "a",
                  cid: null,
                  feature_id: null,
                  address: "5 Elm St, Rivermoor, TX",
                  rating: { rating_type: "Max5", value: 4.2, votes_count: 31, rating_max: 5 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res[0]).toMatchObject({ address: "5 Elm St, Rivermoor, TX", rating: 4.2, reviewCount: 31 });
    const d = createDataForSeoDriver();
    const pts = buildGrid({ ...C, size: 3, radiusM: 1000 }).map((p) => ({ ...p, pingbackUrl: null }));
    const { refs } = await d.submit(pts, "dentist", { name: "Acme Dental", placeId: null });
    const got = await d.collect(refs[0]!);
    expect(got.every((r) => typeof r.address === "string" && typeof r.reviewCount === "number")).toBe(
      true,
    );
    const point = resolvePointResult(got, { name: "Acme Dental", placeId: null });
    expect(point.competitors.every((x) => x.address !== undefined)).toBe(true);
  });
});
