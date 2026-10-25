import { afterEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto";
import { createAccessTokenProvider } from "./access-token";
import { GoogleApiError, GoogleRateLimitError } from "./errors";
import { DEFAULT_READ_MASK, LiveGoogleClient, parseRetryAfter } from "./live-client";
import { setGoogleOAuthOverrides } from "./oauth";

type Seen = { url: URL; init: RequestInit };
function fakeFetch(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const s = { url: new URL(String(input)), init: init ?? {} };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  return { fn, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const auth = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe("LiveGoogleClient (fake fetch, no network)", () => {
  const mk = (f: typeof fetch, now = () => 1_000_000) =>
    new LiveGoogleClient({ getAccessToken: async () => "tok-1", fetch: f, now });

  it("listAccounts: GET v1/accounts with bearer token", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { accounts: [{ name: "accounts/1" }] }));
    const res = await mk(fn).listAccounts();
    expect(res.accounts).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    );
    expect(seen[0]!.init.method).toBe("GET");
    expect(auth(seen[0]!.init)).toBe("Bearer tok-1");
  });

  it("listLocations: business information host, required readMask (default and explicit), paging", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { locations: [{ name: "locations/9" }] }));
    const c = mk(fn);
    const r = await c.listLocations("accounts/42");
    expect(r.locations[0]).toMatchObject({ name: "locations/9", account: "accounts/42" });
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/42/locations",
    );
    expect(seen[0]!.url.searchParams.get("readMask")).toBe(DEFAULT_READ_MASK);
    await c.listLocations("accounts/42", { readMask: "title", pageToken: "p2", pageSize: 100 });
    const q = seen[1]!.url.searchParams;
    expect([q.get("readMask"), q.get("pageToken"), q.get("pageSize")]).toEqual([
      "title",
      "p2",
      "100",
    ]);
    expect(auth(seen[1]!.init)).toBe("Bearer tok-1");
  });

  it("listLocationAdmins: account management host, GET locations/{l}/admins, empty when Google omits admins", async () => {
    const { fn, seen } = fakeFetch(() =>
      json(200, { admins: [{ name: "locations/9/admins/1", admin: "Rosa", role: "OWNER" }] }),
    );
    const c = mk(fn);
    expect((await c.listLocationAdmins("locations/9")).admins).toEqual([
      { name: "locations/9/admins/1", admin: "Rosa", role: "OWNER" },
    ]);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(
      "https://mybusinessaccountmanagement.googleapis.com/v1/locations/9/admins",
    );
    expect(seen[0]!.init.method).toBe("GET");
    const empty = fakeFetch(() => json(200, {}));
    expect((await mk(empty.fn).listLocationAdmins("locations/9")).admins).toEqual([]);
    await expect(mk(empty.fn).listLocationAdmins("accounts/1")).rejects.toThrow();
  });

  it("listLocations tolerates Google omitting `locations` when empty", async () => {
    const { fn } = fakeFetch(() => json(200, {}));
    expect((await mk(fn).listLocations("accounts/42")).locations).toEqual([]);
  });

  it("getLocation: GET v1/locations/{id}?readMask=", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { name: "locations/9", title: "T" }));
    await mk(fn).getLocation("locations/9", { readMask: "title,websiteUri" });
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/locations/9",
    );
    expect(seen[0]!.url.searchParams.get("readMask")).toBe("title,websiteUri");
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.init.body).toBeUndefined();
  });

  it("updateLocation: PATCH with updateMask query, JSON body and content-type", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { name: "locations/9", title: "New" }));
    const out = await mk(fn).updateLocation("locations/9", { title: "New" }, [
      "title",
      "websiteUri",
    ]);
    expect(out.title).toBe("New");
    const s = seen[0]!;
    expect(s.url.origin + s.url.pathname).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/locations/9",
    );
    expect(s.url.searchParams.get("updateMask")).toBe("title,websiteUri");
    expect(s.init.method).toBe("PATCH");
    expect(s.init.body).toBe(JSON.stringify({ title: "New" }));
    expect((s.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(auth(s.init)).toBe("Bearer tok-1");
  });

  it("rejects resource names that could escape the URL path", async () => {
    const { fn, seen } = fakeFetch(() => json(200, {}));
    const c = mk(fn);
    await expect(c.getLocation("locations/9/../../x")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(c.getLocation("accounts/9")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(c.listLocations("accounts/1/locations/2")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(seen).toHaveLength(0);
  });

  it("maps 429 to GoogleRateLimitError with Retry-After seconds", async () => {
    const { fn } = fakeFetch(() =>
      json(429, { error: { status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "7" }),
    );
    const e = await mk(fn)
      .getLocation("locations/9")
      .catch((x) => x);
    expect(e).toBeInstanceOf(GoogleRateLimitError);
    expect(e.retryAfterMs).toBe(7000);
  });

  it("parses Retry-After as an HTTP-date relative to now, and tolerates absence/garbage", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(parseRetryAfter("Tue, 01 Jan 2030 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 31 Dec 2029 23:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });

  it("maps other non-2xx to GoogleApiError with status and Google's body", async () => {
    const body = { error: { code: 400, message: "bad mask", status: "INVALID_ARGUMENT" } };
    const { fn } = fakeFetch(() => json(400, body));
    const e = await mk(fn)
      .updateLocation("locations/9", {}, ["x"])
      .catch((x) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e).not.toBeInstanceOf(GoogleRateLimitError);
    expect(e.status).toBe(400);
    expect(e.body).toEqual(body);
    expect(e.message).toContain("bad mask");
  });

  it("adds Google's fieldViolations to the GoogleApiError message, body unchanged", async () => {
    const body = {
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "filter", description: "displayName is the only supported filter" },
            ],
          },
        ],
      },
    };
    const { fn } = fakeFetch(() => json(400, body));
    const e = await mk(fn)
      .listCategories({ regionCode: "US", languageCode: "en", view: "BASIC", filter: "x" })
      .catch((x) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e.message).toBe(
      "Google API error 400: Request contains an invalid argument. (filter: displayName is the only supported filter)",
    );
    expect(e.body).toEqual(body);
  });

  it("listCategories: GET v1/categories with region, language, view, filter and paging", async () => {
    const { fn, seen } = fakeFetch(() =>
      json(200, { categories: [{ name: "categories/gcid:dentist", displayName: "Dentist" }] }),
    );
    const r = await mk(fn).listCategories({
      regionCode: "US",
      languageCode: "en",
      view: "BASIC",
      filter: 'displayName="dent"',
      pageSize: 20,
    });
    expect(r.categories).toEqual([{ name: "categories/gcid:dentist", displayName: "Dentist" }]);
    const u = seen[0]!.url;
    expect(u.origin + u.pathname).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/categories",
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      regionCode: "US",
      languageCode: "en",
      view: "BASIC",
      filter: 'displayName="dent"',
      pageSize: "20",
    });
    expect(auth(seen[0]!.init)).toBe("Bearer tok-1");
  });

  it("listCategories tolerates Google omitting `categories`", async () => {
    const { fn } = fakeFetch(() => json(200, {}));
    expect(
      (await mk(fn).listCategories({ regionCode: "US", languageCode: "en", view: "BASIC" }))
        .categories,
    ).toEqual([]);
  });

  it("batchGetCategories: one `names` parameter per name, FULL view", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { categories: [] }));
    await mk(fn).batchGetCategories({
      names: ["categories/gcid:dentist", "categories/gcid:plumber"],
      languageCode: "en",
      regionCode: "US",
      view: "FULL",
    });
    const u = seen[0]!.url;
    expect(u.pathname).toBe("/v1/categories:batchGet");
    expect(u.searchParams.getAll("names")).toEqual([
      "categories/gcid:dentist",
      "categories/gcid:plumber",
    ]);
    expect(u.searchParams.get("view")).toBe("FULL");
    await expect(
      mk(fn).batchGetCategories({ names: [], languageCode: "en", view: "FULL" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      mk(fn).batchGetCategories({ names: ["../locations/1"], languageCode: "en", view: "FULL" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("listAttributeMetadata: GET v1/attributes by categoryName, region and language", async () => {
    const { fn, seen } = fakeFetch(() => json(200, {}));
    const r = await mk(fn).listAttributeMetadata({
      categoryName: "categories/gcid:dentist",
      regionCode: "US",
      languageCode: "en",
      pageSize: 200,
      pageToken: "p2",
    });
    expect(r.attributeMetadata).toEqual([]);
    const u = seen[0]!.url;
    expect(u.origin + u.pathname).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/attributes",
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      categoryName: "categories/gcid:dentist",
      regionCode: "US",
      languageCode: "en",
      pageSize: "200",
      pageToken: "p2",
    });
  });
});

describe("createAccessTokenProvider (fake token endpoint)", () => {
  afterEach(() => setGoogleOAuthOverrides({}));

  function setup(expiresIn = 3600) {
    let n = 0;
    const { fn, seen } = fakeFetch(() =>
      json(200, { access_token: `at-${++n}`, expires_in: expiresIn }),
    );
    setGoogleOAuthOverrides({
      fetch: fn,
      tokenUrl: "https://token.test/token",
      clientId: "cid",
      clientSecret: "csec",
    });
    return { seen };
  }
  const conn = { refreshTokenEnc: encryptSecret("rt-secret") };

  it("exchanges the decrypted refresh token and caches until 60s before expiry", async () => {
    const { seen } = setup(3600);
    let t = 0;
    const get = createAccessTokenProvider(conn, { now: () => t });
    expect(await get()).toBe("at-1");
    const form = seen[0]!.init.body as URLSearchParams;
    expect(seen[0]!.url.href).toBe("https://token.test/token");
    expect(Object.fromEntries(form)).toEqual({
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt-secret",
      grant_type: "refresh_token",
    });
    t = (3600 - 61) * 1000;
    expect(await get()).toBe("at-1");
    expect(seen).toHaveLength(1);
    t = (3600 - 59) * 1000;
    expect(await get()).toBe("at-2");
    expect(seen).toHaveLength(2);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    const { seen } = setup();
    const get = createAccessTokenProvider(conn, { now: () => 0 });
    const tokens = await Promise.all([get(), get(), get()]);
    expect(tokens).toEqual(["at-1", "at-1", "at-1"]);
    expect(seen).toHaveLength(1);
  });

  it("surfaces a rejected refresh as GoogleApiError carrying only the OAuth error code", async () => {
    const { fn } = fakeFetch(() =>
      json(400, { error: "invalid_grant", error_description: "revoked" }),
    );
    setGoogleOAuthOverrides({ fetch: fn, tokenUrl: "https://token.test/token" });
    const e = await createAccessTokenProvider(conn)().catch((x) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ error: "invalid_grant" });
  });
});
