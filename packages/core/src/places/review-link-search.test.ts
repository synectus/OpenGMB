import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_LINK_TOOL } from "../config/review-link-tool";
import { liveAutocomplete, livePlaceExists } from "./client";
import { choicesFrom, fixtureCheck, fixtureSearch, searchPlaces } from "./review-link-search";

let server: Server;
let base: string;
let seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let respond: () => { status: number; json: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const r = respond();
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  seen = [];
});

const pred = (placeId: string, types: string[], main = "Acme Plumbing", second = "1 Main St, Town") => ({
  placePrediction: { placeId, types, structuredFormat: { mainText: { text: main }, secondaryText: { text: second } } },
});

describe("liveAutocomplete", () => {
  it("POSTs the input with the key, the narrow field mask, no session token", async () => {
    respond = () => ({ status: 200, json: { suggestions: [] } });
    const ac = liveAutocomplete({ baseUrl: base, key: async () => "k", fieldMask: REVIEW_LINK_TOOL.autocompleteFieldMask });
    await ac("acme plumbing springfield");
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/v1/places:autocomplete");
    expect(s.headers["x-goog-api-key"]).toBe("k");
    expect(s.headers["x-goog-fieldmask"]).toBe(REVIEW_LINK_TOOL.autocompleteFieldMask);
    expect(JSON.parse(s.body)).toEqual({ input: "acme plumbing springfield", languageCode: "en" });
    expect(s.body).not.toMatch(/sessionToken/i);
  });
  it("a non-2xx answer throws without the key or the query", async () => {
    respond = () => ({ status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    const err = (await liveAutocomplete({ baseUrl: base, key: async () => "secret-k", fieldMask: "x" })("my secret query").catch((e: unknown) => e)) as Error;
    expect(String(err.message)).toContain("403");
    expect(String(err.message)).not.toMatch(/secret/);
  });
  it("aborts after the timeout", async () => {
    respond = () => ({ status: 200, json: {}, delayMs: 300 });
    await expect(liveAutocomplete({ baseUrl: base, key: async () => "k", fieldMask: "x", timeoutMs: 50 })("q")).rejects.toBeTruthy();
  });
});

describe("livePlaceExists", () => {
  const ex = () => livePlaceExists({ baseUrl: base, key: async () => "k" });
  it("GET with the id-only mask: 200 true, 404 false, other or timeout null", async () => {
    respond = () => ({ status: 200, json: { id: "x" } });
    expect(await ex()("ChIJabcdefghij")).toBe(true);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/v1/places/ChIJabcdefghij");
    expect(seen[0]!.headers["x-goog-fieldmask"]).toBe("id");
    respond = () => ({ status: 404, json: {} });
    expect(await ex()("ChIJabcdefghij")).toBe(false);
    respond = () => ({ status: 500, json: {} });
    expect(await ex()("ChIJabcdefghij")).toBeNull();
    respond = () => ({ status: 200, json: {}, delayMs: 300 });
    expect(await livePlaceExists({ baseUrl: base, key: async () => "k", timeoutMs: 50 })("ChIJabcdefghij")).toBeNull();
  });
});

describe("choicesFrom", () => {
  it("maps name and address, drops areas and bad IDs, caps at five, tolerates junk", () => {
    const raw = { suggestions: [pred("ChIJgood000001", ["plumber", "establishment"]), pred("ChIJcity000001", ["locality", "political"], "Springfield"), pred("bad id!", ["establishment"]), pred("ChIJnotypes001", [], "No Types"), { queryPrediction: {} }, pred("ChIJnoname0001", ["establishment"], "")] };
    const c = choicesFrom(raw);
    expect(c.map((x) => x.placeId)).toEqual(["ChIJgood000001", "ChIJnotypes001"]);
    expect(c[0]).toEqual({ placeId: "ChIJgood000001", name: "Acme Plumbing", address: "1 Main St, Town" });
    for (const junk of [null, undefined, 5, "x", {}, { suggestions: "no" }]) expect(choicesFrom(junk)).toEqual([]);
    const many = { suggestions: Array.from({ length: 9 }, (_, i) => pred(`ChIJmany00000${i}`, ["establishment"])) };
    expect(choicesFrom(many)).toHaveLength(5);
  });
});

describe("searchPlaces", () => {
  it("takes the budget first and never calls Google when refused", async () => {
    const search = vi.fn(fixtureSearch);
    expect(await searchPlaces({ query: "plumb", search, takeBudget: async () => false })).toEqual({ status: "budget_exhausted" });
    expect(search).not.toHaveBeenCalled();
    const ok = await searchPlaces({ query: "plumb", search, takeBudget: async () => true });
    expect(ok.status === "ok" && ok.choices.length).toBe(3);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("fixture: none for other queries; existence by prefix", async () => {
    const r = await searchPlaces({ query: "zzz", search: fixtureSearch, takeBudget: async () => true });
    expect(r).toEqual({ status: "ok", choices: [] });
    expect(await fixtureCheck("ChIJfixtureplumbing0001")).toBe(true);
    expect(await fixtureCheck("ChIJrealorfake00001")).toBe(false);
  });
});

describe("source scan", () => {
  it("places files never log or use a session token, and apps/web neither reads the key nor exposes it (the settings screen only names it)", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files).toContain("client.ts");
    expect(files).toContain("review-link-search.ts"); // canary: both were read
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/console\./);
      expect(src.replace(/no session token[^\n]*/g, ""), f).not.toMatch(/sessionToken/);
    }
    const web = join(dir, "../../../../apps/web");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.name === "node_modules" || e.name === ".next" ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : [],
      );
    const all = walk(web);
    expect(all.length).toBeGreaterThan(50);
    const readers = all.filter((f) => !f.endsWith(".test.ts") && !f.includes("playwright.config") && /process\.env\.GOOGLE_PLACES_SERVER_KEY|NEXT_PUBLIC_\w*PLACES|getIntegration\w*\("GOOGLE_PLACES_SERVER_KEY"/.test(readFileSync(f, "utf8")));
    expect(readers).toEqual([]);
  });
});
