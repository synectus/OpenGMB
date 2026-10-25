import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@opengmb/db";
import { PROFILE_METADATA } from "./config/profile-metadata";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import {
  metadataLocale,
  resetMetadataCacheForTests,
  setMetadataClockForTests,
  toAttributeOut,
} from "./profile/metadata";
import { codeOf, makeKit, type Org } from "./testkit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;
const calls = (method: string) => mock.calls.filter((c) => c.method === method).length;
const US = { regionCode: "US", languageCode: "en" };

let org: Org;
let locationId: string;
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await kit.makeOrg();
  locationId = (await org.mkLoc(org.a)).row.id;
});
beforeEach(() => {
  resetMetadataCacheForTests();
  setMetadataClockForTests(null);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await sql.end();
});

type Cat = { name: string; displayName: string };

describe("profile.categories.search", () => {
  it("finds categories by display name and says the data is sample data", async () => {
    const r = await run<{ categories: Cat[]; source: string }>(
      org.manager,
      "profile.categories.search",
      {
        locationId,
        ...US,
        query: "pain",
      },
    );
    expect(r.categories).toEqual([
      { name: "categories/gcid:pain_control_clinic", displayName: "Pain control clinic" },
      {
        name: "categories/gcid:pain_management_physician",
        displayName: "Pain management physician",
      },
    ]);
    expect(r.source).toBe("sample");
  });

  it("a query under the minimum length makes no call", async () => {
    const before = calls("listCategories");
    const r = await run<{ categories: Cat[] }>(org.manager, "profile.categories.search", {
      locationId,
      ...US,
      query: "p".repeat(PROFILE_METADATA.searchMinChars - 1),
    });
    expect(r.categories).toEqual([]);
    expect(calls("listCategories")).toBe(before);
  });

  it("the same search is served from the cache until the TTL passes", async () => {
    let t = 1_000_000;
    setMetadataClockForTests(() => t);
    const search = () =>
      run(org.manager, "profile.categories.search", { locationId, ...US, query: "Dent" });
    const before = calls("listCategories");
    await search();
    await search();
    expect(calls("listCategories")).toBe(before + 1);
    t += PROFILE_METADATA.cacheTtlMs;
    await search();
    expect(calls("listCategories")).toBe(before + 2);
  });

  it("keys the cache by region: another region is another call", async () => {
    const before = calls("listCategories");
    await run(org.manager, "profile.categories.search", { locationId, ...US, query: "plumb" });
    await run(org.manager, "profile.categories.search", {
      locationId,
      regionCode: "AU",
      languageCode: "en-AU",
      query: "plumb",
    });
    expect(calls("listCategories")).toBe(before + 2);
  });
});

describe("profile.categories.get", () => {
  it("returns service types and fetches only names it has not cached", async () => {
    const get = (names: string[]) =>
      run<{
        categories: (Cat & { serviceTypes: { serviceTypeId: string; displayName: string }[] })[];
      }>(org.manager, "profile.categories.get", { locationId, ...US, names });
    const before = mock.calls.length;
    const a = await get(["categories/gcid:pain_control_clinic"]);
    expect(a.categories[0]!.serviceTypes.map((s) => s.displayName)).toEqual([
      "Pain management consultation",
      "Physical therapy evaluation",
      "Injury rehabilitation",
    ]);
    const b = await get(["categories/gcid:pain_control_clinic", "categories/gcid:medical_clinic"]);
    expect(b.categories.map((c) => c.name)).toEqual([
      "categories/gcid:pain_control_clinic",
      "categories/gcid:medical_clinic",
    ]);
    const batch = mock.calls.slice(before).filter((c) => c.method === "batchGetCategories");
    expect(batch.map((c) => (c.args[0] as { names: string[] }).names)).toEqual([
      ["categories/gcid:pain_control_clinic"],
      ["categories/gcid:medical_clinic"],
    ]);
  });

  it("an unknown id comes back as nothing and is not asked for again", async () => {
    const before = calls("batchGetCategories");
    for (let i = 0; i < 2; i++) {
      const r = await run<{ categories: Cat[] }>(org.manager, "profile.categories.get", {
        locationId,
        ...US,
        names: ["categories/gcid:not_a_category"],
      });
      expect(r.categories).toEqual([]);
    }
    expect(calls("batchGetCategories")).toBe(before + 1);
  });
});

describe("profile.attributes.metadata", () => {
  type Attr = { name: string; valueType: string; groupDisplayName: string };
  it("lists the category's attributes without deprecated ones, cached", async () => {
    const before = calls("listAttributeMetadata");
    const meta = () =>
      run<{ attributes: Attr[]; source: string }>(org.manager, "profile.attributes.metadata", {
        locationId,
        ...US,
        categoryName: "categories/gcid:pain_control_clinic",
      });
    const r = await meta();
    await meta();
    expect(calls("listAttributeMetadata")).toBe(before + 1);
    expect(r.attributes.some((a) => a.name === "attributes/has_fax")).toBe(false);
    expect(r.attributes.find((a) => a.name === "attributes/url_facebook")).toMatchObject({
      valueType: "URL",
      groupDisplayName: "Social profiles",
    });
    expect(r.attributes.length).toBeGreaterThan(5);
  });

  it("another category has its own list (plumber: no social profiles)", async () => {
    const r = await run<{ attributes: Attr[] }>(org.manager, "profile.attributes.metadata", {
      locationId,
      ...US,
      categoryName: "categories/gcid:plumber",
    });
    expect(r.attributes.map((a) => a.name)).toEqual([
      "attributes/has_onsite_services",
      "attributes/url_appointment",
    ]);
  });
});

describe("scope and input", () => {
  it("a client in another workspace cannot use the location; bad locale is INVALID_INPUT", async () => {
    expect(
      await codeOf(
        run(org.approverB, "profile.categories.search", { locationId, ...US, query: "pain" }),
      ),
    ).toMatch(/NOT_FOUND|FORBIDDEN/);
    expect(
      await codeOf(
        run(org.manager, "profile.categories.search", {
          locationId,
          regionCode: "usa",
          languageCode: "en",
          query: "pain",
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("a viewer of the workspace may read metadata (read only)", async () => {
    const r = await run<{ categories: Cat[] }>(org.viewerA, "profile.categories.search", {
      locationId,
      ...US,
      query: "clinic",
    });
    expect(r.categories.length).toBeGreaterThan(0);
  });
});

describe("pure helpers", () => {
  it("metadataLocale: address region, then the language's region, then the default", () => {
    expect(metadataLocale({ languageCode: "en", storefrontAddress: { regionCode: "IN" } })).toEqual(
      {
        regionCode: "IN",
        languageCode: "en",
      },
    );
    expect(metadataLocale({ languageCode: "en-AU" })).toEqual({
      regionCode: "AU",
      languageCode: "en-AU",
    });
    expect(metadataLocale({})).toEqual({
      regionCode: PROFILE_METADATA.defaultRegionCode,
      languageCode: PROFILE_METADATA.defaultLanguageCode,
    });
  });

  it("toAttributeOut adds the attributes/ prefix when Google leaves it out", () => {
    expect(toAttributeOut({ parent: "has_wifi", valueType: "BOOL" })).toMatchObject({
      name: "attributes/has_wifi",
      displayName: "has_wifi",
      groupDisplayName: "Other",
      values: [],
    });
  });
});
