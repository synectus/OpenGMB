import { describe, expect, it } from "vitest";
import { GoogleApiError } from "./errors";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";

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
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const headers = (init: RequestInit) => init.headers as Record<string, string>;
const P = "accounts/1/locations/2";

describe("LiveGoogleClient photo upload (fake fetch, no network)", () => {
  const mk = (f: typeof fetch) =>
    new LiveGoogleClient({ getAccessToken: async () => "tok-1", fetch: f });

  it("startMediaUpload: POST v4/{parent}/media:startUpload with no body, returns the dataRef", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { resourceName: "AF1QipUPLOAD_ref-1" }));
    const ref = await mk(fn).startMediaUpload(P);
    expect(ref).toEqual({ resourceName: "AF1QipUPLOAD_ref-1" });
    expect(seen[0]!.url.toString()).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/media:startUpload",
    );
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.body).toBeUndefined();
    expect(headers(seen[0]!.init).authorization).toBe("Bearer tok-1");
  });

  it("startMediaUpload: a response without resourceName is an error, a bad parent is rejected before any request", async () => {
    const { fn, seen } = fakeFetch(() => json(200, {}));
    await expect(mk(fn).startMediaUpload(P)).rejects.toThrow(/upload reference/);
    await expect(mk(fn).startMediaUpload("accounts/1/../x")).rejects.toThrow(
      /Invalid location parent/,
    );
    expect(seen).toHaveLength(1);
  });

  it("uploadMediaBytes: POST /upload/v1/media/{resourceName}?uploadType=media with the raw bytes and the image content type", async () => {
    const { fn, seen } = fakeFetch(() => new Response("", { status: 200 }));
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    await mk(fn).uploadMediaBytes({ resourceName: "AF1QipUPLOAD_ref-1" }, bytes, "image/jpeg");
    const s = seen[0]!;
    expect(s.url.origin + s.url.pathname).toBe(
      "https://mybusiness.googleapis.com/upload/v1/media/AF1QipUPLOAD_ref-1",
    );
    expect(s.url.searchParams.get("uploadType")).toBe("media");
    expect(s.init.method).toBe("POST");
    expect(headers(s.init)["content-type"]).toBe("image/jpeg");
    expect(headers(s.init).authorization).toBe("Bearer tok-1");
    expect(Array.from(s.init.body as unknown as Uint8Array)).toEqual(Array.from(bytes));
  });

  it("uploadMediaBytes: resource names that could escape the path are rejected before any request", async () => {
    const { fn, seen } = fakeFetch(() => new Response("", { status: 200 }));
    for (const name of ["../v4/accounts", "/abs", "a b", "a?x=1", ""]) {
      await expect(
        mk(fn).uploadMediaBytes({ resourceName: name }, new Uint8Array(1), "image/png"),
      ).rejects.toThrow(/Invalid media upload reference/);
    }
    expect(seen).toHaveLength(0);
  });

  it("uploadMediaBytes: a Google error surfaces as GoogleApiError", async () => {
    const { fn } = fakeFetch(() => json(400, { error: { message: "bad" } }));
    await expect(
      mk(fn).uploadMediaBytes({ resourceName: "r1" }, new Uint8Array(1), "image/png"),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });

  it("createMedia with a dataRef sends it in the JSON body instead of sourceUrl", async () => {
    const { fn, seen } = fakeFetch(() => json(200, { name: `${P}/media/m1` }));
    await mk(fn).createMedia(P, {
      mediaFormat: "PHOTO",
      locationAssociation: { category: "EXTERIOR" },
      dataRef: { resourceName: "AF1QipUPLOAD_ref-1" },
    });
    expect(seen[0]!.url.toString()).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/media",
    );
    expect(headers(seen[0]!.init)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      mediaFormat: "PHOTO",
      locationAssociation: { category: "EXTERIOR" },
      dataRef: { resourceName: "AF1QipUPLOAD_ref-1" },
    });
  });
});

describe("MockGoogleClient photo upload", () => {
  it("create with a dataRef needs bytes uploaded first and returns a Google-hosted url", async () => {
    const m = new MockGoogleClient();
    const parent = "accounts/100000000000000000001/locations/200000000000000001";
    const ref = await m.startMediaUpload(parent);
    await expect(
      m.createMedia(parent, { locationAssociation: { category: "ADDITIONAL" }, dataRef: ref }),
    ).rejects.toBeInstanceOf(GoogleApiError); // no bytes yet
    await m.uploadMediaBytes(ref, new Uint8Array(10), "image/png");
    const item = await m.createMedia(parent, {
      locationAssociation: { category: "ADDITIONAL" },
      dataRef: ref,
    });
    expect(item.googleUrl).toContain("lh3.");
    expect(item.sourceUrl).toBeUndefined();
    await expect(
      m.uploadMediaBytes({ resourceName: "nope" }, new Uint8Array(1), "image/png"),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});
