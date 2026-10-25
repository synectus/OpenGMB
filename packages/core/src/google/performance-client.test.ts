import { describe, expect, it } from "vitest";
import { DAILY_METRICS } from "./client";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";

describe("MockGoogleClient performance fixtures", () => {
  it("fetchDailyMetrics is deterministic per location/date/metric and differs between locations", async () => {
    const a = await new MockGoogleClient().fetchDailyMetrics(
      "locations/1",
      ["CALL_CLICKS", "WEBSITE_CLICKS"],
      "2026-09-01",
      "2026-09-10",
    );
    const b = await new MockGoogleClient().fetchDailyMetrics(
      "locations/1",
      ["CALL_CLICKS", "WEBSITE_CLICKS"],
      "2026-09-01",
      "2026-09-10",
    );
    expect(a).toEqual(b);
    expect(a.series).toHaveLength(2);
    expect(a.series[0]!.points).toHaveLength(10);
    expect(a.series[0]!.points[0]!.date).toBe("2026-09-01");
    // a sub-range reads the same values as the matching slice of the larger range
    const sub = await new MockGoogleClient().fetchDailyMetrics(
      "locations/1",
      ["CALL_CLICKS"],
      "2026-09-03",
      "2026-09-04",
    );
    expect(sub.series[0]!.points).toEqual(a.series[0]!.points.slice(2, 4));
    const other = await new MockGoogleClient().fetchDailyMetrics(
      "locations/2",
      ["CALL_CLICKS"],
      "2026-09-01",
      "2026-09-10",
    );
    expect(other.series[0]!.points).not.toEqual(a.series[0]!.points);
  });

  it("rejects a reversed range", async () => {
    await expect(
      new MockGoogleClient().fetchDailyMetrics(
        "locations/1",
        ["CALL_CLICKS"],
        "2026-09-10",
        "2026-09-01",
      ),
    ).rejects.toThrow(/Invalid date range/);
  });

  it("listMonthlySearchKeywords is deterministic, sorted, and uses threshold for small counts", async () => {
    const m = new MockGoogleClient();
    const seen = new Set<string>();
    let sawThreshold = false;
    let sawValue = false;
    for (const loc of ["locations/1", "locations/2", "locations/3", "locations/4"]) {
      for (const month of ["2026-07", "2026-08", "2026-09"]) {
        const r = await m.listMonthlySearchKeywords(loc, month, month);
        expect(r).toEqual(
          await new MockGoogleClient().listMonthlySearchKeywords(loc, month, month),
        );
        for (const k of r.keywords) {
          expect(typeof k.value === "number").not.toBe(typeof k.threshold === "number");
          if (k.threshold !== undefined) sawThreshold = true;
          if (k.value !== undefined) sawValue = true;
          seen.add(k.keyword);
        }
      }
    }
    expect(sawThreshold).toBe(true);
    expect(sawValue).toBe(true);
    expect(seen.size).toBeGreaterThan(3);
  });

  it("pages keywords", async () => {
    const m = new MockGoogleClient();
    const p1 = await m.listMonthlySearchKeywords("locations/1", "2026-09", "2026-09", {
      pageSize: 2,
    });
    expect(p1.keywords).toHaveLength(2);
    expect(p1.nextPageToken).toBe("2");
    const p2 = await m.listMonthlySearchKeywords("locations/1", "2026-09", "2026-09", {
      pageSize: 2,
      pageToken: p1.nextPageToken,
    });
    expect(p2.keywords[0]).not.toEqual(p1.keywords[0]);
  });
});

type Seen = { url: URL; init: RequestInit };
function fakeFetch(body: unknown) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fn, seen };
}

describe("LiveGoogleClient performance calls (fake fetch, no network)", () => {
  it("fetchDailyMetrics: URL, repeated dailyMetrics, dated range; parses int64 strings and omitted zeros", async () => {
    const { fn, seen } = fakeFetch({
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            {
              dailyMetric: "CALL_CLICKS",
              timeSeries: {
                datedValues: [
                  { date: { year: 2026, month: 9, day: 1 }, value: "7" },
                  { date: { year: 2026, month: 9, day: 2 } },
                ],
              },
            },
            {
              dailyMetric: "WEBSITE_CLICKS",
              dailySubEntityType: {},
              timeSeries: { datedValues: [] },
            },
          ],
        },
      ],
    });
    const c = new LiveGoogleClient({ getAccessToken: async () => "tok", fetch: fn });
    const r = await c.fetchDailyMetrics(
      "locations/9",
      ["CALL_CLICKS", "WEBSITE_CLICKS"],
      "2026-09-01",
      "2026-09-02",
    );
    const u = seen[0]!.url;
    expect(u.origin + u.pathname).toBe(
      "https://businessprofileperformance.googleapis.com/v1/locations/9:fetchMultiDailyMetricsTimeSeries",
    );
    expect(u.searchParams.getAll("dailyMetrics")).toEqual(["CALL_CLICKS", "WEBSITE_CLICKS"]);
    expect(u.searchParams.get("dailyRange.start_date.year")).toBe("2026");
    expect(u.searchParams.get("dailyRange.start_date.month")).toBe("9");
    expect(u.searchParams.get("dailyRange.start_date.day")).toBe("1");
    expect(u.searchParams.get("dailyRange.end_date.day")).toBe("2");
    expect(seen[0]!.init.method).toBe("GET");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(r.series).toEqual([
      {
        metric: "CALL_CLICKS",
        points: [
          { date: "2026-09-01", value: 7 },
          { date: "2026-09-02", value: 0 },
        ],
      },
    ]);
  });

  it("listMonthlySearchKeywords: URL, month range, paging; value vs threshold", async () => {
    const { fn, seen } = fakeFetch({
      searchKeywordsCounts: [
        { searchKeyword: "dentist", insightsValue: { value: "120" } },
        { searchKeyword: "rare", insightsValue: { threshold: "15" } },
      ],
      nextPageToken: "n2",
    });
    const c = new LiveGoogleClient({ getAccessToken: async () => "tok", fetch: fn });
    const r = await c.listMonthlySearchKeywords("locations/9", "2026-08", "2026-09", {
      pageToken: "p",
      pageSize: 100,
    });
    const u = seen[0]!.url;
    expect(u.origin + u.pathname).toBe(
      "https://businessprofileperformance.googleapis.com/v1/locations/9/searchkeywords/impressions/monthly",
    );
    expect(u.searchParams.get("monthlyRange.start_month.year")).toBe("2026");
    expect(u.searchParams.get("monthlyRange.start_month.month")).toBe("8");
    expect(u.searchParams.get("monthlyRange.end_month.month")).toBe("9");
    expect(u.searchParams.get("pageToken")).toBe("p");
    expect(u.searchParams.get("pageSize")).toBe("100");
    expect(r).toEqual({
      keywords: [
        { keyword: "dentist", value: 120 },
        { keyword: "rare", threshold: 15 },
      ],
      nextPageToken: "n2",
    });
  });

  it("rejects names that could escape the path, and the enum lists 11 metrics", async () => {
    const c = new LiveGoogleClient({ getAccessToken: async () => "t", fetch: fakeFetch({}).fn });
    await expect(
      c.fetchDailyMetrics("locations/../x", ["CALL_CLICKS"], "2026-09-01", "2026-09-02"),
    ).rejects.toThrow();
    expect(DAILY_METRICS).toHaveLength(11);
  });
});
