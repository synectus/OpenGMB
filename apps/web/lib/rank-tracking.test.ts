import { describe, expect, it } from "vitest";
import {
  adjacentScans,
  budgetLine,
  costLine,
  defaultRunId,
  destLabel,
  geogridHref,
  gridLabel,
  mapsBrowserKey,
  monthLine,
  parseView,
  progressLine,
  quickWins,
  rankDataIsSample,
  rankDelta,
  runErrorParts,
  sortKeywords,
  toggleFavorite,
  usd,
  VIEWS,
  writesAreOff,
  type HealthCheckLite,
  type RunLite,
} from "./rank-tracking";

describe("views and links", () => {
  it("has the views in canvas order and falls back to Trackers", () => {
    expect(VIEWS.map((v) => v.label)).toEqual(["Trackers", "Keyword rank", "Competitors", "New tracker", "Quick scan", "Usage and key"]);
    expect(parseView("usage")).toBe("usage");
    expect(parseView("scan")).toBe("scan");
    expect(parseView("nope")).toBe("trackers");
    expect(parseView(undefined)).toBe("trackers");
  });
  it("builds hrefs without the default view", () => {
    expect(geogridHref({})).toBe("/geogrid");
    expect(geogridHref({ view: "competitors", config: "c", keyword: "emergency dentist" })).toBe(
      "/geogrid?view=competitors&config=c&keyword=emergency+dentist",
    );
    expect(geogridHref({ view: "trackers", config: "c", run: "r" })).toBe("/geogrid?config=c&run=r");
    expect(geogridHref({ view: "new" })).toBe("/geogrid?view=new");
  });
});

describe("text", () => {
  it("money has two decimals, tiny amounts say so", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0753)).toBe("$0.08");
    expect(usd(3.12)).toBe("$3.12");
    expect(usd(0.0007)).toBe("under $0.01");
  });
  it("grid text has thousands separators", () => {
    expect(gridLabel(7, 3000)).toBe("7x7 grid, 3,000 m to the edge");
  });
  it("month, cost and budget lines read like the canvas", () => {
    expect(
      monthLine({ monthToDateUsd: 3.12, monthlyBudgetUsd: 25, markupPercent: 28, isDefault: true }),
    ).toBe("This month: $3.12 of $25.00 budget. Markup 28% (defaults).");
    const p = {
      points: 49,
      keywordCount: 2,
      estimateUsd: 0.0753,
      markupPercent: 28,
      byoKey: false,
      monthToDateUsd: 3.12,
      monthlyBudgetUsd: 25,
      remainingUsd: 21.88,
      wouldExceed: false,
    };
    expect(costLine(p)).toBe("49 points x 2 keywords = $0.08 (includes 28% markup)");
    expect(costLine({ ...p, keywordCount: 1, byoKey: true, markupPercent: 0 })).toBe(
      "49 points x 1 keyword = $0.08 (your own key, no markup)",
    );
    expect(budgetLine(p)).toBe("This month so far $3.12 of $25.00; $21.88 left.");
    expect(budgetLine({ ...p, remainingUsd: -1 })).toBe("This month so far $3.12 of $25.00; $0.00 left.");
  });
  it("progress and errors", () => {
    expect(progressLine("running", { collected: 13, total: 25 })).toBe("Running: 13 of 25 points");
    expect(progressLine("queued", { collected: 0, total: 25 })).toBe("Queued: 0 of 25 points");
    expect(progressLine("done", { collected: 25, total: 25 })).toBeNull();
    expect(runErrorParts("BUDGET_EXCEEDED: The monthly budget is used up.")).toEqual({
      code: "BUDGET_EXCEEDED",
      message: "The monthly budget is used up.",
    });
    expect(runErrorParts("No point could be collected")).toEqual({
      code: null,
      message: "No point could be collected",
    });
  });
});

describe("scans", () => {
  const r = (id: string, keyword: string, createdAt: string, status = "done", avg: number | null = 5): RunLite => ({
    id,
    keyword,
    status,
    createdAt,
    finishedAt: status === "done" ? createdAt : null,
    summary: { averageRank: avg },
  });
  const runs = [
    r("n", "pain clinic rivermoor", "2026-10-18T08:12:00Z", "running"),
    r("c", "pain clinic rivermoor", "2026-10-14T09:00:00Z", "done", 4.8),
    r("o", "pain management near me", "2026-10-14T09:00:00Z"),
    r("p", "pain clinic rivermoor", "2026-10-07T09:00:00Z", "done", 5.6),
    r("f", "pain clinic rivermoor", "2026-10-01T09:00:00Z", "failed"),
  ];
  it("previous and next stay on the same keyword and skip unfinished runs", () => {
    const nav = adjacentScans(runs, runs[1]!);
    expect(nav.previous?.id).toBe("p");
    expect(nav.next).toBeNull();
    expect(adjacentScans(runs, runs[3]!).next?.id).toBe("c");
  });
  it("a lower average rank is better", () => {
    expect(rankDelta(4.8, 5.6)).toEqual({ label: "Up 0.8", tone: "good" });
    expect(rankDelta(6.1, 5.6)).toEqual({ label: "Down 0.5", tone: "bad" });
    expect(rankDelta(5, 5)).toEqual({ label: "No change", tone: "neutral" });
    expect(rankDelta(null, 5)).toBeNull();
  });
  it("opens the newest finished run of the first favourite, else the newest finished, else the newest", () => {
    expect(defaultRunId(runs, ["pain management near me"])).toBe("o");
    expect(defaultRunId(runs, [])).toBe("c");
    expect(defaultRunId([runs[0]!], [])).toBe("n");
    expect(defaultRunId([], [])).toBeNull();
  });
  it("favourites come first and toggle", () => {
    expect(sortKeywords(["a", "b", "c"], ["c"])).toEqual(["c", "a", "b"]);
    expect(toggleFavorite(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("quick wins", () => {
  const c = (
    id: string,
    importance: HealthCheckLite["importance"],
    status: HealthCheckLite["status"],
    href: string | null,
  ): HealthCheckLite => ({
    id,
    title: id.toUpperCase(),
    importance,
    status,
    detail: `detail ${id}`,
    fix: href ? { label: "Fix", href } : null,
  });
  it("takes failing checks with a fix, necessary first, at most three", () => {
    const wins = quickWins([
      c("photo", "important", "fail", "/locations/x/media"),
      c("pass", "necessary", "pass", "/locations/x/profile"),
      c("nofix", "necessary", "fail", null),
      c("unknown", "necessary", "unknown", "/locations/x/profile"),
      c("reviews", "necessary", "fail", "/reviews?replied=no&loc=x"),
      c("cats", "important", "fail", "/locations/x/profile"),
      c("post", "nice", "fail", "/posts?view=compose"),
    ]);
    expect(wins.map((w) => w.id)).toEqual(["reviews", "photo", "cats"]);
    expect(wins[0]).toEqual({
      id: "reviews",
      text: "REVIEWS: detail reviews",
      href: "/reviews?replied=no&loc=x",
      dest: "Reviews",
    });
  });
  it("names the destination by its route", () => {
    expect(destLabel("/locations/x/media")).toBe("Photos");
    expect(destLabel("/locations/x/profile")).toBe("Profile");
    expect(destLabel("/posts?view=compose")).toBe("Posts");
    expect(destLabel("/reviews?loc=x")).toBe("Reviews");
    expect(destLabel("/somewhere")).toBe("Health");
  });
});

describe("environment", () => {
  it("reads the Maps browser key, empty means not set", () => {
    expect(mapsBrowserKey({})).toBeNull();
    expect(mapsBrowserKey({ GOOGLE_MAPS_BROWSER_KEY: "  " })).toBeNull();
    expect(mapsBrowserKey({ GOOGLE_MAPS_BROWSER_KEY: " AIzaX " })).toBe("AIzaX");
  });
  it("rank data is sample and writes are off on a default server", () => {
    expect(rankDataIsSample({})).toBe(true);
    expect(writesAreOff({})).toBe(true);
    expect(writesAreOff({ GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "live" })).toBe(false);
  });
});
