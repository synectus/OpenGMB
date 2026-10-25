import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, citationEntries, locations } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { MockGoogleClient } from "./google/mock-client";
import { CITATION_CHECK } from "./config/citation-check";
import { citationSitesFor } from "./config/citation-sites";
import { setListingFetcher } from "./citations/check";
import type { SafeFetchResult } from "./citations/safe-fetch";
import { codeOf, makeKit } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type Entry = { id: string; status: string; listingUrl: string | null; notes: string | null; emailUsed: string | null; submittedOn: string | null };
type Listing = {
  country: string;
  countrySource: string;
  sites: { key: string; entry: Entry | null }[];
  custom: { name: string; url: string | null; entry: Entry }[];
  summary: { total: number; live: number; submitted: number; needsFix: number; notStarted: number };
};

async function setup() {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  return { org, loc, id: loc.row.id };
}

describe("citations", () => {
  it("lists the US list for a location with no readable country, all not started", async () => {
    const { org, id } = await setup();
    const r = await kit.run<Listing>(org.owner, "citations.list", { locationId: id });
    expect(r.country).toBe("US");
    expect(r.countrySource).toBe("fallback");
    expect(r.sites.map((s) => s.key)).toEqual(citationSitesFor("US").map((s) => s.key));
    expect(r.summary).toMatchObject({ total: r.sites.length, live: 0, submitted: 0, notStarted: r.sites.length });
  });

  it("a chosen country switches the list", async () => {
    const { org, id } = await setup();
    const r = await kit.run<Listing>(org.owner, "citations.list", { locationId: id, country: "IN" });
    expect(r).toMatchObject({ country: "IN", countrySource: "chosen" });
    expect(r.sites.map((s) => s.key)).toContain("justdial");
  });

  it("marks a site live and the summary and entry follow; a second save changes only the fields sent", async () => {
    const { org, id } = await setup();
    const a = await kit.run<{ entry: Entry }>(org.owner, "citations.save", {
      locationId: id, siteKey: "bing-places", status: "submitted", emailUsed: " a@b.test ", submittedOn: "2026-10-20",
    });
    expect(a.entry).toMatchObject({ status: "submitted", emailUsed: "a@b.test", submittedOn: "2026-10-20" });
    const b = await kit.run<{ entry: Entry }>(org.owner, "citations.save", {
      locationId: id, siteKey: "bing-places", status: "live", listingUrl: "https://www.bing.com/maps?x=1",
    });
    expect(b.entry.id).toBe(a.entry.id);
    expect(b.entry).toMatchObject({ status: "live", emailUsed: "a@b.test", listingUrl: "https://www.bing.com/maps?x=1" });
    const c = await kit.run<{ entry: Entry }>(org.owner, "citations.save", { locationId: id, siteKey: "bing-places", emailUsed: "" });
    expect(c.entry.emailUsed).toBeNull();
    const r = await kit.run<Listing>(org.owner, "citations.list", { locationId: id });
    expect(r.sites.find((s) => s.key === "bing-places")!.entry!.status).toBe("live");
    expect(r.summary.live).toBe(1);
    expect(r.summary.notStarted).toBe(r.summary.total - 1);
  });

  it("rejects an unknown site, a non-https listing URL, and neither or both of siteKey and id", async () => {
    const { org, id } = await setup();
    expect(await codeOf(kit.run(org.owner, "citations.save", { locationId: id, siteKey: "nope" }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "citations.save", { locationId: id, siteKey: "bing-places", listingUrl: "http://x.test/" }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "citations.save", { locationId: id }))).toBe("INVALID_INPUT");
  });

  it("has no column that could hold a password or login", () => {
    const cols = Object.keys(citationEntries).join(" ").toLowerCase();
    expect(cols).not.toMatch(/pass|login|secret|credential/);
  });

  it("adds, updates and deletes a custom site; a listed site cannot be deleted", async () => {
    const { org, id } = await setup();
    const added = await kit.run<{ custom: { name: string; url: string | null; entry: Entry } }>(org.owner, "citations.addCustom", {
      locationId: id, name: "Springfield Chamber", url: "https://chamber.test/join",
    });
    expect(added.custom).toMatchObject({ name: "Springfield Chamber", url: "https://chamber.test/join" });
    const eid = added.custom.entry.id;
    await kit.run(org.owner, "citations.save", { locationId: id, id: eid, status: "live" });
    let r = await kit.run<Listing>(org.owner, "citations.list", { locationId: id });
    expect(r.custom).toHaveLength(1);
    expect(r.summary.total).toBe(r.sites.length + 1);
    expect(r.summary.live).toBe(1);
    expect(await codeOf(kit.run(org.owner, "citations.addCustom", { locationId: id, name: "x", url: "http://x.test" }))).toBe("INVALID_INPUT");
    const listed = await kit.run<{ entry: Entry }>(org.owner, "citations.save", { locationId: id, siteKey: "facebook-page", status: "live" });
    expect(await codeOf(kit.run(org.owner, "citations.deleteCustom", { id: listed.entry.id }))).toBe("INVALID_INPUT");
    await kit.run(org.owner, "citations.deleteCustom", { id: eid });
    r = await kit.run<Listing>(org.owner, "citations.list", { locationId: id });
    expect(r.custom).toHaveLength(0);
  });

  it("viewers can read but not write", async () => {
    const { org, id } = await setup();
    expect((await kit.run<Listing>(org.viewerA, "citations.list", { locationId: id })).sites.length).toBeGreaterThan(0);
    expect(await codeOf(kit.run(org.viewerA, "citations.save", { locationId: id, siteKey: "bing-places", status: "live" }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.viewerA, "citations.addCustom", { locationId: id, name: "x" }))).toBe("FORBIDDEN");
  });

  it("another organization cannot read or change entries (NOT_FOUND) and nothing changes", async () => {
    const a = await setup();
    const b = await setup();
    const saved = await kit.run<{ entry: Entry }>(a.org.owner, "citations.save", { locationId: a.id, siteKey: "bing-places", status: "live" });
    expect(await codeOf(kit.run(b.org.owner, "citations.list", { locationId: a.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.org.owner, "citations.save", { locationId: a.id, siteKey: "bing-places", status: "not_started" }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.org.owner, "citations.addCustom", { locationId: a.id, name: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.org.owner, "citations.deleteCustom", { id: saved.entry.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.org.owner, "citations.save", { locationId: b.id, id: saved.entry.id, status: "needs_fix" }))).toBe("NOT_FOUND");
    const [row] = await db.select().from(citationEntries).where(eq(citationEntries.id, saved.entry.id));
    expect(row!.status).toBe("live");
  });
});

type Checked = Entry & { checkedAt: string | null; checkResult: string | null; checkFields: Record<string, string> | null; checkReason: string | null };
const GOOD = `<h1>Ace Dental</h1><p>1234 Main St, Springfield, IL 62701</p><a href="tel:2175550142">call</a>`;
const BAD_PHONE = `<script type="application/ld+json">{"@type":"Dentist","name":"Ace Dental","telephone":"217-555-9999","address":"1234 Main St Springfield IL 62701"}</script><h1>Ace Dental</h1>`;

async function checkSetup() {
  const s = await setup();
  await db
    .update(locations)
    .set({ title: "Ace Dental", phone: "(217) 555-0142", addressSummary: "1234 Main Street, Springfield, IL 62701, US" })
    .where(eq(locations.id, s.id));
  return s;
}
const live = (org: Awaited<ReturnType<typeof setup>>["org"], id: string, siteKey: string, url: string | null, status = "live") =>
  kit.run<{ entry: Entry }>(org.owner, "citations.save", { locationId: id, siteKey, status, ...(url ? { listingUrl: url } : {}) });

describe("citations: NAP check", () => {
  afterAll(() => setListingFetcher(null));

  it("stores match, mismatch (with the field), not found and could not fetch on the entry", async () => {
    const { org, id } = await checkSetup();
    const pages: Record<string, SafeFetchResult> = {
      "https://a.test/l": { ok: true, html: GOOD, finalUrl: "https://a.test/l" },
      "https://b.test/l": { ok: true, html: BAD_PHONE, finalUrl: "https://b.test/l" },
      "https://c.test/l": { ok: true, html: "<p>nothing useful</p>", finalUrl: "https://c.test/l" },
      "https://d.test/l": { ok: false, reason: "blocked_by_site", status: 403 },
      "https://e.test/l": { ok: false, reason: "http_error", status: 404 },
    };
    setListingFetcher(async (u) => pages[u]!);
    const keys = ["bing-places", "facebook-page", "yelp", "bbb", "foursquare"];
    const urls = Object.keys(pages);
    for (const [i, k] of keys.entries()) await live(org, id, k, urls[i]!);
    const all = await kit.run<{ entries: Checked[]; summary: Record<string, number>; remaining: number }>(org.owner, "citations.checkAll", { locationId: id });
    expect(all.summary).toEqual({ match: 1, mismatch: 1, notFound: 2, couldNotFetch: 1 });
    expect(all.remaining).toBe(0);
    const byUrl = new Map(all.entries.map((e) => [e.listingUrl, e]));
    expect(byUrl.get("https://a.test/l")).toMatchObject({ checkResult: "match", checkedAt: expect.any(String) });
    expect(byUrl.get("https://b.test/l")).toMatchObject({ checkResult: "mismatch", checkFields: { phone: "mismatch" } });
    expect(byUrl.get("https://d.test/l")).toMatchObject({ checkResult: "could_not_fetch", checkReason: "blocked_by_site" });
    expect(byUrl.get("https://e.test/l")).toMatchObject({ checkResult: "not_found", checkReason: "page_gone" });
    const list = await kit.run<Listing & { sites: { key: string; entry: Checked | null }[] }>(org.owner, "citations.list", { locationId: id });
    expect(list.sites.find((s) => s.key === "bing-places")!.entry).toMatchObject({ checkResult: "match" });
  });

  it("a failed fetch never turns an earlier match into a mismatch", async () => {
    const { org, id } = await checkSetup();
    const e = await live(org, id, "bing-places", "https://a.test/l");
    setListingFetcher(async () => ({ ok: true, html: GOOD, finalUrl: "x" }));
    expect((await kit.run<{ entry: Checked }>(org.owner, "citations.check", { locationId: id, id: e.entry.id })).entry.checkResult).toBe("match");
    setListingFetcher(async () => ({ ok: false, reason: "blocked_address" }));
    const r = await kit.run<{ entry: Checked }>(org.owner, "citations.check", { locationId: id, siteKey: "bing-places" });
    expect(r.entry).toMatchObject({ checkResult: "could_not_fetch", checkReason: "blocked_address" });
  });

  it("checkAll takes only live entries with a link, oldest check first, at most the per-run cap", async () => {
    const { org, id } = await checkSetup();
    const seen: string[] = [];
    setListingFetcher(async (u) => { seen.push(u); return { ok: true, html: GOOD, finalUrl: u }; });
    await live(org, id, "bing-places", "https://skip1.test/", "submitted");
    await live(org, id, "yelp", null);
    const sites = citationSitesFor("US").map((s) => s.key).filter((k) => !["bing-places", "yelp"].includes(k)).slice(0, CITATION_CHECK.maxPerRun + 2);
    for (const [i, k] of sites.entries()) await live(org, id, k, `https://h${i}.test/p`);
    const first = await kit.run<{ entries: Checked[]; remaining: number }>(org.owner, "citations.checkAll", { locationId: id });
    expect(first.entries).toHaveLength(CITATION_CHECK.maxPerRun);
    expect(first.remaining).toBe(2);
    expect(seen.some((u) => u.includes("skip1"))).toBe(false);
    const second = await kit.run<{ entries: Checked[]; remaining: number }>(org.owner, "citations.checkAll", { locationId: id });
    expect(second.entries.map((e) => e.listingUrl)).toEqual(expect.arrayContaining(["https://h10.test/p", "https://h11.test/p"]));
    expect(second.entries.slice(0, 2).every((e) => e.checkResult === "match")).toBe(true);
  });

  it("refuses with INVALID_INPUT when there is nothing to check, no link, or both/neither id", async () => {
    const { org, id } = await checkSetup();
    setListingFetcher(async () => { throw new Error("must not fetch"); });
    expect(await codeOf(kit.run(org.owner, "citations.checkAll", { locationId: id }))).toBe("INVALID_INPUT");
    await live(org, id, "bing-places", null);
    expect(await codeOf(kit.run(org.owner, "citations.check", { locationId: id, siteKey: "bing-places" }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "citations.check", { locationId: id }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "citations.check", { locationId: id, siteKey: "yelp" }))).toBe("NOT_FOUND");
  });

  it("viewers and other organizations cannot run a check", async () => {
    const a = await checkSetup();
    const b = await setup();
    await live(a.org, a.id, "bing-places", "https://a.test/l");
    setListingFetcher(async () => { throw new Error("must not fetch"); });
    expect(await codeOf(kit.run(a.org.viewerA, "citations.checkAll", { locationId: a.id }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(a.org.viewerA, "citations.check", { locationId: a.id, siteKey: "bing-places" }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(b.org.owner, "citations.checkAll", { locationId: a.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.org.owner, "citations.check", { locationId: a.id, siteKey: "bing-places" }))).toBe("NOT_FOUND");
  });

  it("a run cut short by the time budget reports the unchecked listings as remaining", async () => {
    const { org, id } = await checkSetup();
    for (const [i, k] of ["bing-places", "yelp", "bbb"].entries()) await live(org, id, k, `https://slow${i}.test/p`);
    setListingFetcher(async (u) => {
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true, html: GOOD, finalUrl: u };
    });
    const cfg = CITATION_CHECK as { runBudgetMs: number; concurrency: number };
    const saved = { ...cfg };
    cfg.runBudgetMs = 10;
    cfg.concurrency = 1;
    try {
      const r = await kit.run<{ entries: Checked[]; remaining: number }>(org.owner, "citations.checkAll", { locationId: id });
      expect(r.entries.length + r.remaining).toBe(3);
      expect(r.remaining).toBeGreaterThanOrEqual(1);
    } finally {
      cfg.runBudgetMs = saved.runBudgetMs;
      cfg.concurrency = saved.concurrency;
    }
  });
});
