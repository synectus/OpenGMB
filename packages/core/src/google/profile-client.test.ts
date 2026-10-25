import { afterAll, describe, expect, it } from "vitest";
import { createDb, organizations } from "@opengmb/db";
import { CoreError } from "../errors";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { ThrottledGoogleClient } from "./throttled-client";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const L = "locations/200000000000000001";

describe("MockGoogleClient profile fields", () => {
  it("applies nested update masks and clears a masked field missing from the patch", async () => {
    const m = new MockGoogleClient();
    const before = await m.getLocation(L);
    await m.updateLocation(
      L,
      {
        profile: { description: "Family dentistry." },
        openInfo: { openingDate: { year: 2015, month: 3, day: 1 } },
        websiteUri: undefined,
      },
      ["profile", "openInfo.openingDate", "websiteUri"],
    );
    const after = await m.getLocation(L);
    expect(after.profile).toEqual({ description: "Family dentistry." });
    expect(after.openInfo).toEqual({ openingDate: { year: 2015, month: 3, day: 1 } });
    expect(after.websiteUri).toBeUndefined();
    expect(after.title).toBe(before.title); // unmasked fields untouched
    expect(after.regularHours).toEqual(before.regularHours);
  });

  it("ignores patch fields that are not in the mask", async () => {
    const m = new MockGoogleClient();
    await m.updateLocation(L, { title: "Sneaky", websiteUri: "https://x.example.test" }, [
      "websiteUri",
    ]);
    const l = await m.getLocation(L);
    expect(l.title).not.toBe("Sneaky");
    expect(l.websiteUri).toBe("https://x.example.test");
  });

  it("attributes: mask+body sets, mask only deletes, body only is ignored", async () => {
    const m = new MockGoogleClient();
    const name = `${L}/attributes`;
    const start = (await m.getAttributes(name)).attributes!.map((a) => a.name);
    expect(start).toEqual(["attributes/has_wifi", "attributes/url_appointment"]);
    await m.updateAttributes(
      name,
      {
        name,
        attributes: [
          { name: "attributes/has_wifi", values: [false] },
          { name: "attributes/has_parking", values: [true] },
        ],
      },
      ["attributes/has_wifi", "attributes/url_appointment"],
    );
    const now = (await m.getAttributes(name)).attributes!;
    expect(now.map((a) => a.name)).toEqual(["attributes/has_wifi"]); // url deleted, parking ignored
    expect(now[0]!.values).toEqual([false]);
    await expect(m.updateAttributes(name, { name }, [])).rejects.toBeInstanceOf(CoreError);
    await expect(m.updateAttributes(name, { name }, ["has_wifi"])).rejects.toBeInstanceOf(
      CoreError,
    );
    await expect(m.getAttributes("locations/nope/attributes")).rejects.toBeInstanceOf(CoreError);
  });
});

describe("LiveGoogleClient attributes (fake fetch, no network)", () => {
  type Seen = { url: URL; init: RequestInit };
  function mk(body: unknown) {
    const seen: Seen[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { seen, c: new LiveGoogleClient({ getAccessToken: async () => "t", fetch: fn }) };
  }

  it("getAttributes: GET v1/locations/{l}/attributes", async () => {
    const { seen, c } = mk({ name: `${L}/attributes` });
    const r = await c.getAttributes(`${L}/attributes`);
    expect(r.attributes).toEqual([]);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${L}/attributes`,
    );
    expect(seen[0]!.init.method).toBe("GET");
  });

  it("updateAttributes: PATCH with attributeMask query and body", async () => {
    const { seen, c } = mk({ name: `${L}/attributes` });
    const body = { name: `${L}/attributes`, attributes: [{ name: "attributes/has_wifi" }] };
    await c.updateAttributes(`${L}/attributes`, body, ["attributes/has_wifi", "attributes/x"]);
    expect(seen[0]!.init.method).toBe("PATCH");
    expect(seen[0]!.url.searchParams.get("attributeMask")).toBe("attributes/has_wifi,attributes/x");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(body);
    await expect(c.updateAttributes(`${L}/attributes`, body, [])).rejects.toBeInstanceOf(CoreError);
    await expect(c.getAttributes("locations/1/../attributes")).rejects.toBeInstanceOf(CoreError);
  });

  it("updateLocation sends updateMask for nested paths and refuses an empty mask", async () => {
    const { seen, c } = mk({ name: L });
    await c.updateLocation(L, { profile: { description: "x" } }, [
      "profile",
      "openInfo.openingDate",
    ]);
    expect(seen[0]!.url.searchParams.get("updateMask")).toBe("profile,openInfo.openingDate");
    await expect(c.updateLocation(L, {}, [])).rejects.toBeInstanceOf(CoreError);
  });
});

describe("ThrottledGoogleClient.updateAttributes", () => {
  it("takes the per-location edit bucket and is idempotent", async () => {
    const mock = new MockGoogleClient();
    const g = new ThrottledGoogleClient(mock, db);
    const [org] = await db
      .insert(organizations)
      .values({ name: `o-${Math.random()}` })
      .returning();
    const ctx = { orgId: org!.id, idempotencyKey: `attr-${Math.random()}` };
    const body = {
      name: `${L}/attributes`,
      attributes: [{ name: "attributes/has_wifi", values: [false] }],
    };
    await g.updateAttributes(L, body, ["attributes/has_wifi"], ctx);
    await g.updateAttributes(L, body, ["attributes/has_wifi"], ctx);
    expect(mock.calls.filter((c) => c.method === "updateAttributes")).toHaveLength(1);
    await expect(g.updateAttributes(L, body, ["attributes/other"], ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
