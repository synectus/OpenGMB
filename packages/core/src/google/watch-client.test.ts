import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@opengmb/db";
import { CoreError } from "../errors";
import { GoogleApiError } from "./errors";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { ThrottledGoogleClient } from "./throttled-client";
import { PostgresRateLimiter, currentProjectBucket, locationEditBucket } from "./throttler";

// The shared test database is also used by every other suite, often at the same time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

type Seen = { url: URL; init: RequestInit };
function live(respond: (s: Seen) => Response = () => json(200, {})) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const s = { url: new URL(String(input)), init: init ?? {} };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  return { c: new LiveGoogleClient({ getAccessToken: async () => "tok", fetch: fetchFn }), seen };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const at = (s: Seen) => s.url.origin + s.url.pathname;
const L = "locations/200000000000000001";
const P = "accounts/100000000000000000001/locations/200000000000000001";

describe("LiveGoogleClient: change watch, media, verification, place actions (fake fetch)", () => {
  it("getGoogleUpdated: GET v1/{name}:getGoogleUpdated with a readMask", async () => {
    const { c, seen } = live(() =>
      json(200, { location: { name: L, title: "T" }, diffMask: "profile" }),
    );
    const r = await c.getGoogleUpdated(L, { readMask: "name,profile" });
    expect(r).toMatchObject({ diffMask: "profile", location: { title: "T" } });
    expect(at(seen[0]!)).toBe(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${L}:getGoogleUpdated`,
    );
    expect(seen[0]!.url.searchParams.get("readMask")).toBe("name,profile");
    expect(seen[0]!.init.method).toBe("GET");
    await expect(c.getGoogleUpdated("locations/1/../2")).rejects.toBeInstanceOf(CoreError);
  });

  it("media: v4 list / customers / create / delete, empty lists default to []", async () => {
    const { c, seen } = live();
    expect((await c.listMedia(P, { pageSize: 100, pageToken: "t" })).mediaItems).toEqual([]);
    expect(at(seen[0]!)).toBe(`https://mybusiness.googleapis.com/v4/${P}/media`);
    expect(seen[0]!.url.searchParams.get("pageSize")).toBe("100");
    expect((await c.listCustomerMedia(P)).mediaItems).toEqual([]);
    expect(at(seen[1]!)).toBe(`https://mybusiness.googleapis.com/v4/${P}/media/customers`);
    await c.createMedia(P, {
      mediaFormat: "PHOTO",
      locationAssociation: { category: "COVER" },
      sourceUrl: "https://x.test/a.jpg",
    });
    expect(seen[2]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[2]!.init.body))).toEqual({
      mediaFormat: "PHOTO",
      locationAssociation: { category: "COVER" },
      sourceUrl: "https://x.test/a.jpg",
    });
    await c.deleteMedia(`${P}/media/abc`);
    expect(seen[3]!.init.method).toBe("DELETE");
    expect(at(seen[3]!)).toBe(`https://mybusiness.googleapis.com/v4/${P}/media/abc`);
    await expect(c.deleteMedia(`${P}/media/../x`)).rejects.toBeInstanceOf(CoreError);
    await expect(c.listMedia("locations/1")).rejects.toBeInstanceOf(CoreError);
  });

  it("verifications: VoiceOfMerchantState and verifications.list on the verifications host", async () => {
    const { c, seen } = live((s) =>
      s.url.pathname.endsWith("VoiceOfMerchantState")
        ? json(200, { hasVoiceOfMerchant: true, waitForVoiceOfMerchant: {} })
        : json(200, {}),
    );
    expect(await c.getVoiceOfMerchantState(L)).toEqual({
      hasVoiceOfMerchant: true,
      waitForVoiceOfMerchant: {},
    });
    expect(at(seen[0]!)).toBe(
      `https://mybusinessverifications.googleapis.com/v1/${L}/VoiceOfMerchantState`,
    );
    expect((await c.listVerifications(L, { pageSize: 5 })).verifications).toEqual([]);
    expect(at(seen[1]!)).toBe(
      `https://mybusinessverifications.googleapis.com/v1/${L}/verifications`,
    );
    expect(seen.every((s) => s.init.method === "GET")).toBe(true); // reads only
  });

  it("place action links: list with the type filter, create, patch with updateMask, delete", async () => {
    const { c, seen } = live();
    expect(
      (await c.listPlaceActionLinks(L, { placeActionType: "APPOINTMENT", pageSize: 10 }))
        .placeActionLinks,
    ).toEqual([]);
    expect(at(seen[0]!)).toBe(
      `https://mybusinessplaceactions.googleapis.com/v1/${L}/placeActionLinks`,
    );
    expect(seen[0]!.url.searchParams.get("filter")).toBe("place_action_type=APPOINTMENT");
    await c.createPlaceActionLink(L, { uri: "https://b.test/x", placeActionType: "APPOINTMENT" });
    expect(seen[1]!.init.method).toBe("POST");
    const name = `${L}/placeActionLinks/9`;
    await c.updatePlaceActionLink(name, { isPreferred: true }, ["isPreferred"]);
    expect(seen[2]!.init.method).toBe("PATCH");
    expect(seen[2]!.url.searchParams.get("updateMask")).toBe("isPreferred");
    await expect(c.updatePlaceActionLink(name, {}, [])).rejects.toBeInstanceOf(CoreError);
    await c.deletePlaceActionLink(name);
    expect(seen[3]!.init.method).toBe("DELETE");
    await expect(
      c.deletePlaceActionLink("locations/1/placeActionLinks/../x"),
    ).rejects.toBeInstanceOf(CoreError);
  });

  it("food menus: GET v4 .../foodMenus, PATCH with updateMask=menus, names validated", async () => {
    const name = `${P}/foodMenus`;
    const { c, seen } = live(() => json(200, {}));
    expect(await c.getFoodMenus(name)).toEqual({ name, menus: [] });
    expect(at(seen[0]!)).toBe(`https://mybusiness.googleapis.com/v4/${name}`);
    expect(seen[0]!.init.method).toBe("GET");
    await c.updateFoodMenus({ name, menus: [] }, ["menus"]);
    expect(seen[1]!.init.method).toBe("PATCH");
    expect(seen[1]!.url.searchParams.get("updateMask")).toBe("menus");
    await expect(c.updateFoodMenus({ name, menus: [] }, [])).rejects.toBeInstanceOf(CoreError);
    await expect(c.getFoodMenus("locations/1/foodMenus")).rejects.toBeInstanceOf(CoreError);
  });
});

describe("MockGoogleClient: the Google rules the new methods mirror", () => {
  it("media: https only, LOGO maps to PROFILE, one cover / one profile photo, profile name is fixed", async () => {
    const m = new MockGoogleClient();
    await expect(
      m.createMedia(P, {
        sourceUrl: "http://x.test/a.jpg",
        locationAssociation: { category: "COVER" },
      }),
    ).rejects.toBeInstanceOf(GoogleApiError);
    await expect(m.createMedia(P, { sourceUrl: "https://x.test/a.jpg" })).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    const logo = await m.createMedia(P, {
      sourceUrl: "https://x.test/l.png",
      locationAssociation: { category: "LOGO" },
    });
    expect(logo).toMatchObject({
      name: `${P}/media/profile`,
      locationAssociation: { category: "PROFILE" },
      createTime: "1970-01-01T00:00:00Z",
    });
    expect(logo.sourceUrl).toBeUndefined(); // not retained for profile photos
    await m.createMedia(P, {
      sourceUrl: "https://x.test/l2.png",
      locationAssociation: { category: "PROFILE" },
    });
    await m.createMedia(P, {
      sourceUrl: "https://x.test/c.jpg",
      locationAssociation: { category: "COVER" },
    });
    await m.createMedia(P, {
      sourceUrl: "https://x.test/c2.jpg",
      locationAssociation: { category: "COVER" },
    });
    const items = (await m.listMedia(P)).mediaItems;
    expect(items.map((i) => i.locationAssociation?.category).sort()).toEqual(["COVER", "PROFILE"]);
    await expect(m.deleteMedia(`${P}/media/nope`)).rejects.toMatchObject({ status: 404 });
  });

  it("getGoogleUpdated: diffMask only for paths that differ; a patch of the path clears the suggestion", async () => {
    const m = new MockGoogleClient();
    expect((await m.getGoogleUpdated(L, { readMask: "name" })).diffMask).toBeUndefined();
    m.suggestGoogleChange(
      L,
      { profile: { description: "Google wrote this" }, title: "New Title" },
      ["profile", "title"],
    );
    const g = await m.getGoogleUpdated(L, { readMask: "name,title,profile" });
    expect(g.diffMask?.split(",").sort()).toEqual(["profile", "title"]);
    expect(g.location.title).toBe("New Title");
    expect((await m.getLocation(L, { readMask: "name,title" })).title).not.toBe("New Title");
    await m.updateLocation(L, { title: "New Title" }, ["title"]); // accept
    expect((await m.getGoogleUpdated(L, { readMask: "name" })).diffMask).toBe("profile");
    await m.updateLocation(L, {}, ["profile"]); // reject: patch the merchant's (empty) value back
    expect((await m.getGoogleUpdated(L, { readMask: "name" })).diffMask).toBeUndefined();
    await expect(m.getGoogleUpdated("locations/404")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("place action links: one per (uri, type), one preferred per type, aggregator links are read only", async () => {
    const m = new MockGoogleClient();
    const a = await m.createPlaceActionLink(L, {
      uri: "https://b.test/a",
      placeActionType: "APPOINTMENT",
      isPreferred: true,
    });
    const b = await m.createPlaceActionLink(L, {
      uri: "https://b.test/b",
      placeActionType: "APPOINTMENT",
      isPreferred: true,
    });
    await expect(
      m.createPlaceActionLink(L, { uri: "https://b.test/a", placeActionType: "APPOINTMENT" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      m.createPlaceActionLink(L, { uri: "http://b.test/a", placeActionType: "APPOINTMENT" }),
    ).rejects.toMatchObject({ status: 400 });
    const list = (await m.listPlaceActionLinks(L, { placeActionType: "APPOINTMENT" }))
      .placeActionLinks;
    expect(list.map((l) => [l.uri, l.isPreferred])).toEqual([
      ["https://b.test/a", false],
      ["https://b.test/b", true],
    ]);
    await m.updatePlaceActionLink(a.name!, { isPreferred: true }, ["isPreferred"]);
    expect(
      (await m.listPlaceActionLinks(L, { placeActionType: "APPOINTMENT" })).placeActionLinks.find(
        (l) => l.name === b.name,
      )!.isPreferred,
    ).toBe(false);
    await expect(
      m.updatePlaceActionLink(a.name!, { providerType: "MERCHANT" }, ["providerType"]),
    ).rejects.toBeInstanceOf(CoreError);
    const agg = (await m.listPlaceActionLinks(L)).placeActionLinks.find(
      (l) => l.isEditable === false,
    )!;
    await expect(m.deletePlaceActionLink(agg.name!)).rejects.toMatchObject({ status: 400 });
    await m.deletePlaceActionLink(a.name!);
    await expect(m.deletePlaceActionLink(a.name!)).rejects.toMatchObject({ status: 404 });
  });
});

describe("ThrottledGoogleClient: media and place action writes", () => {
  it("take the profile edit bucket for the location (v4 and v1 spellings) and are idempotent", async () => {
    const m = new MockGoogleClient();
    // Its own location: the edit bucket allows 10 per minute and other suites use the fixture one.
    const own = `locations/9${Date.now()}${Math.floor(Math.random() * 1000)}`;
    m.addLocation({ name: own, title: "Throttle" });
    const parent = `accounts/100000000000000000001/${own}`;
    const t = new ThrottledGoogleClient(m, db);
    const spy = vi.spyOn(PostgresRateLimiter.prototype, "acquire");
    const org = (
      await db
        .insert((await import("@opengmb/db")).organizations)
        .values({ name: `o-${Date.now()}` })
        .returning()
    )[0]!;
    const ctx = (k: string) => ({ orgId: org.id, idempotencyKey: k });
    const a = await t.createMedia(
      parent,
      { sourceUrl: "https://x.test/a.jpg", locationAssociation: { category: "EXTERIOR" } },
      ctx("m1"),
    );
    const again = await t.createMedia(
      parent,
      { sourceUrl: "https://x.test/a.jpg", locationAssociation: { category: "EXTERIOR" } },
      ctx("m1"),
    );
    expect(again).toEqual(a);
    expect(m.calls.filter((c) => c.method === "createMedia")).toHaveLength(1);
    await expect(
      t.createMedia(
        parent,
        { sourceUrl: "https://x.test/other.jpg", locationAssociation: { category: "EXTERIOR" } },
        ctx("m1"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await t.createPlaceActionLink(
      own,
      { uri: "https://b.test/a", placeActionType: "APPOINTMENT" },
      ctx("p1"),
    );
    // media (accounts/../locations/..) and the link (locations/..) share ONE edit bucket
    const buckets = spy.mock.calls.map((c) => c[0]).filter((k) => k !== currentProjectBucket());
    expect(buckets).toEqual([locationEditBucket(own), locationEditBucket(own)]);
    spy.mockRestore();
  });
});
