import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { livePlacesTransport, PlacesHttpError, placesSource } from "./client";

let server: Server;
let base: string;
let seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let respond: () => { status: number; json: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const r = respond();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  seen = [];
});

const req = {
  textQuery: "dentist",
  maxResultCount: 20,
  locationBias: { circle: { center: { latitude: 27.5, longitude: -99.5 }, radius: 500 } },
  targetPlaceId: "ChIJtarget",
};

describe("live Places transport", () => {
  it("searchText: key and IDs-only field mask headers; body has no targetPlaceId", async () => {
    respond = () => ({ status: 200, json: { places: [{ id: "A" }, { id: "B" }] } });
    const t = livePlacesTransport({ baseUrl: base, key: async () => "k" });
    expect(await t.searchText(req)).toEqual({ places: [{ id: "A" }, { id: "B" }] });
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/v1/places:searchText");
    expect(s.headers["x-goog-api-key"]).toBe("k");
    expect(s.headers["x-goog-fieldmask"]).toBe("places.id");
    const body = JSON.parse(s.body);
    expect(Object.keys(body).sort()).toEqual(["locationBias", "pageSize", "textQuery"]);
    expect(body.pageSize).toBe(20);
    expect(s.body).not.toContain("ChIJtarget");
  });

  it("an empty answer is no places", async () => {
    respond = () => ({ status: 200, json: {} });
    expect(await livePlacesTransport({ baseUrl: base, key: async () => "k" }).searchText(req)).toEqual({ places: [] });
  });

  it("HTTP 403 throws PlacesHttpError with Google's status and no key", async () => {
    respond = () => ({ status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    const err = await livePlacesTransport({ baseUrl: base, key: async () => "super-secret-key" }).searchText(req).catch((e) => e);
    expect(err).toBeInstanceOf(PlacesHttpError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("PERMISSION_DENIED");
    expect(err.message).not.toContain("super-secret-key");
  });

  it("no key throws before any request", async () => {
    await expect(livePlacesTransport({ baseUrl: base, key: async () => null }).searchText(req)).rejects.toThrow(/not set/);
    expect(seen).toHaveLength(0);
  });

  it("canary: a public address is refused by the test network guard", async () => {
    const t = livePlacesTransport({ baseUrl: "https://1.1.1.1", key: async () => "k", timeoutMs: 5000 });
    await expect(t.searchText(req)).rejects.toThrow();
    expect((globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects?.length ?? 0).toBeGreaterThan(0);
  });

  it("placesSource: live with a key, fixture without", () => {
    expect(placesSource({})).toBe("fixture");
    expect(placesSource({ GOOGLE_PLACES_SERVER_KEY: "k" })).toBe("live");
  });
});
