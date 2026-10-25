import { describe, expect, it } from "vitest";
import { outcomeOf, runChecks } from "./check";

const profile = { name: "Ace Dental", address: null, phone: null };
const ok = (html: string) => ({ ok: true as const, html, finalUrl: "x" });

describe("outcomeOf", () => {
  it("never turns a failed fetch into a mismatch", () => {
    for (const reason of ["blocked_by_site", "timeout", "blocked_address", "dns", "too_large", "not_html", "network", "too_many_redirects", "http_error"] as const) {
      expect(outcomeOf({ ok: false, reason, status: 500 }, profile).result).toBe("could_not_fetch");
    }
  });
  it("a 404 or 410 is a gone page (not found)", () => {
    expect(outcomeOf({ ok: false, reason: "http_error", status: 404 }, profile)).toEqual({ result: "not_found", detail: { reason: "page_gone" } });
    expect(outcomeOf({ ok: false, reason: "http_error", status: 410 }, profile).result).toBe("not_found");
  });
  it("a page is compared", () => {
    expect(outcomeOf(ok("<h1>Ace Dental</h1>"), profile).result).toBe("match");
  });
});

describe("runChecks pacing", () => {
  it("waits between two fetches to the same host only", async () => {
    const waits: number[] = [];
    const out = await runChecks(
      [{ url: "https://dir.test/a" }, { url: "https://other.test/a" }, { url: "https://dir.test/b" }],
      profile,
      { fetch: async () => ok("<p>x</p>"), sleep: async (ms) => void waits.push(ms), limits: { perHostDelayMs: 5_000 } },
    );
    expect(out).toHaveLength(3);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(5_000);
  });

  it("runs different hosts at the same time, up to the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const fetch = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return ok("<p>x</p>");
    };
    const items = ["a", "b", "c", "d", "e", "f"].map((h) => ({ url: `https://${h}.test/p` }));
    await runChecks(items, profile, { fetch, limits: { concurrency: 3 } });
    expect(peak).toBe(3);
  });

  it("keeps one host serialized, with the delay, while other hosts run alongside", async () => {
    const events: string[] = [];
    const sleeps: number[] = [];
    const fetch = async (u: string) => {
      events.push(`start ${u}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end ${u}`);
      return ok("<p>x</p>");
    };
    await runChecks([{ url: "https://dir.test/1" }, { url: "https://dir.test/2" }, { url: "https://o.test/1" }], profile, {
      fetch,
      sleep: async (ms) => void sleeps.push(ms),
      limits: { concurrency: 4, perHostDelayMs: 1000 },
    });
    expect(events.indexOf("end https://dir.test/1")).toBeLessThan(events.indexOf("start https://dir.test/2"));
    expect(events.indexOf("start https://o.test/1")).toBeLessThan(events.indexOf("end https://dir.test/1"));
    expect(sleeps).toHaveLength(1);
  });

  it("leaves listings unstarted when the time budget is spent", async () => {
    const fetch = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return ok("<p>x</p>");
    };
    const items = ["a", "b", "c", "d"].map((h) => ({ url: `https://${h}.test/p` }));
    const out = await runChecks(items, profile, { fetch, limits: { concurrency: 1, runBudgetMs: 100 } });
    expect(out[0]).not.toBeNull();
    expect(out[3]).toBeNull();
  });
});
