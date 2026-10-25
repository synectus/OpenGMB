import { describe, expect, it } from "vitest";
import type { GoogleClient } from "./client";
import { GoogleApiError } from "./errors";
import { LiveGoogleClient, REVIEWS_BASE } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { mapStarRating, parseReviewName } from "./reviews";

const A1 = "accounts/100000000000000000001";
const L1 = "locations/200000000000000001";
const L2 = "locations/200000000000000002";
const L3 = "locations/200000000000000003";
const A2 = "accounts/100000000000000000002";

describe("starRating mapping", () => {
  it("maps the v4 enum to 1-5 and everything else to null", () => {
    expect(["ONE", "TWO", "THREE", "FOUR", "FIVE"].map(mapStarRating)).toEqual([1, 2, 3, 4, 5]);
    expect(mapStarRating("STAR_RATING_UNSPECIFIED")).toBeNull();
    expect(mapStarRating(undefined)).toBeNull();
    expect(mapStarRating("SIX")).toBeNull();
  });

  it("parseReviewName accepts only full review names", () => {
    expect(parseReviewName(`${A1}/${L1}/reviews/r1`)).toEqual({
      accountName: A1,
      locationName: L1,
      reviewId: "r1",
    });
    expect(parseReviewName(`${L1}/reviews/r1`)).toBeNull();
    expect(parseReviewName(`${A1}/${L1}/reviews/../x`)).toBeNull();
  });
});

describe("MockGoogleClient reviews", () => {
  const mock = new MockGoogleClient();
  const client: GoogleClient = mock;

  it("serves 8 fixture reviews per fixture location with mapped ratings and mixed content", async () => {
    let total = 0;
    for (const [a, l] of [
      [A1, L1],
      [A1, L2],
      [A2, L3],
    ] as const) {
      const r = await client.listReviews(a, l);
      expect(r.reviews).toHaveLength(8);
      expect(r.totalReviewCount).toBe(8);
      expect(r.averageRating).toBeGreaterThan(1);
      total += r.reviews.length;
      expect(r.reviews.every((x) => typeof x.starRating === "number")).toBe(true);
      expect(r.reviews.some((x) => x.comment === undefined)).toBe(true); // star-only
      expect(r.reviews.some((x) => x.reviewReply)).toBe(true);
      expect(r.reviews.some((x) => x.reviewReply === undefined)).toBe(true);
      expect(r.reviews.some((x) => x.starRating! <= 3)).toBe(true);
      expect(r.reviews.every((x) => x.name.startsWith(`${a}/${l}/reviews/`))).toBe(true);
    }
    console.log(`review fixtures: ${total} reviews across 3 locations`);
    const l1 = await client.listReviews(A1, L1);
    expect(l1.reviews.some((r) => r.comment?.includes("back pain"))).toBe(true);
  });

  it("paginates with pageToken and no gaps or duplicates, newest update first", async () => {
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const r = await client.listReviews(A1, L1, {
        pageSize: 3,
        ...(token ? { pageToken: token } : {}),
      });
      seen.push(...r.reviews.map((x) => x.name));
      token = r.nextPageToken;
      pages++;
    } while (token);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(8);
    const all = (await client.listReviews(A1, L1)).reviews.map((x) => x.name);
    expect(seen).toEqual(all);
  });

  it("getReview, test add/update helpers, and reply writes", async () => {
    const m = new MockGoogleClient();
    const name = m.addReview(A1, L1, { starRating: "TWO", comment: "meh", reviewerName: "Zed" });
    expect(await m.getReview(name)).toMatchObject({ starRating: 2, comment: "meh" });
    m.updateReview(name, { starRating: "FOUR", reply: "Hello" });
    expect(await m.getReview(name)).toMatchObject({
      starRating: 4,
      reviewReply: { comment: "Hello" },
    });
    expect((await m.listReviews(A1, L1)).reviews[0]!.name).toBe(name); // newest update first
    const stored = await m.updateReply(name, "Second");
    expect(stored.comment).toBe("Second");
    await m.deleteReply(name);
    expect((await m.getReview(name)).reviewReply).toBeUndefined();
    await expect(m.getReview(`${A1}/${L1}/reviews/nope`)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await m.listReviews(A1, "locations/unknown")).reviews).toEqual([]);
  });

  it("failure injection applies to review calls", async () => {
    const m = new MockGoogleClient();
    m.failNext(1, () => new Error("boom"));
    await expect(m.listReviews(A1, L1)).rejects.toThrow("boom");
    expect(m.callCount).toBe(1);
  });
});

describe("LiveGoogleClient reviews (fake fetch, no network)", () => {
  type Seen = { url: URL; init: RequestInit };
  function build(respond: (s: Seen) => Response) {
    const seen: Seen[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const s = { url: new URL(String(input)), init: init ?? {} };
      seen.push(s);
      return respond(s);
    }) as typeof fetch;
    return { seen, c: new LiveGoogleClient({ getAccessToken: async () => "tok", fetch: fn }) };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const rname = `${A1}/${L1}/reviews/r1`;

  it("listReviews: v4 host, parent path, pageSize/pageToken, maps ratings, tolerates empty", async () => {
    const { c, seen } = build(() =>
      json(200, {
        reviews: [
          { name: rname, reviewId: "r1", starRating: "THREE", createTime: "t", updateTime: "t" },
          {
            name: rname + "2",
            reviewId: "r2",
            starRating: "STAR_RATING_UNSPECIFIED",
            createTime: "t",
            updateTime: "t",
          },
        ],
        totalReviewCount: 2,
        nextPageToken: "n",
      }),
    );
    const r = await c.listReviews(A1, L1, { pageSize: 50, pageToken: "p" });
    expect(r.reviews.map((x) => x.starRating)).toEqual([3, null]);
    expect(r.nextPageToken).toBe("n");
    const u = seen[0]!.url;
    expect(u.origin + u.pathname).toBe(`${REVIEWS_BASE}/${A1}/${L1}/reviews`);
    expect(REVIEWS_BASE).toBe("https://mybusiness.googleapis.com/v4");
    expect(seen[0]!.init.method).toBe("GET");
    expect([u.searchParams.get("pageSize"), u.searchParams.get("pageToken")]).toEqual(["50", "p"]);
    const empty = build(() => json(200, {}));
    expect((await empty.c.listReviews(A1, L1)).reviews).toEqual([]);
  });

  it("getReview: GET v4/{name}; updateReply: PUT .../reply with {comment}; deleteReply: DELETE .../reply", async () => {
    const { c, seen } = build((s) =>
      s.init.method === "DELETE"
        ? new Response(null, { status: 200 })
        : s.init.method === "PUT"
          ? json(200, { comment: "hi", updateTime: "t" })
          : json(200, {
              name: rname,
              reviewId: "r1",
              starRating: "FIVE",
              createTime: "t",
              updateTime: "t",
            }),
    );
    expect((await c.getReview(rname)).starRating).toBe(5);
    expect(await c.updateReply(rname, "hi")).toEqual({ comment: "hi", updateTime: "t" });
    await c.deleteReply(rname);
    expect(seen.map((s) => [s.init.method, s.url.pathname])).toEqual([
      ["GET", `/v4/${rname}`],
      ["PUT", `/v4/${rname}/reply`],
      ["DELETE", `/v4/${rname}/reply`],
    ]);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ comment: "hi" });
    expect((seen[1]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("rejects names that could escape the path and maps API errors", async () => {
    const { c, seen } = build(() => json(404, { error: { message: "gone" } }));
    await expect(c.getReview(`${A1}/${L1}/reviews/../../x`)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(c.listReviews("accounts/1/../2", L1)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(seen).toHaveLength(0);
    await expect(c.getReview(rname)).rejects.toBeInstanceOf(GoogleApiError);
  });
});
