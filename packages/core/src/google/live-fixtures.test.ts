import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectGoogleSuggestion } from "../profile/watch";
import { DAILY_METRICS } from "./client";
import { LiveGoogleClient } from "./live-client";

/**
 * Responses recorded from the real Business Profile APIs on 2026-10-18 (read-only go-live), with
 * personal data, ids and URLs replaced. Each file: { url (path only), status, body }.
 */
const DIR = new URL("./fixtures/live/", import.meta.url);
type Recorded = { url: string; status: number; body: unknown };
const recorded = new Map<string, Recorded>(
  readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, DIR), "utf8"))]),
);
const rec = (name: string) => {
  const r = recorded.get(name);
  if (!r) throw new Error(`missing fixture ${name}`);
  return r;
};

/** Serves the recorded body whose path matches the request; anything else fails the test. */
function replay(pick?: (path: string) => string | undefined) {
  const seen: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const path = `${u.origin}${u.pathname}`;
    seen.push(path);
    const name = pick?.(path) ?? [...recorded].find(([, r]) => r.url === path)?.[0];
    if (!name) throw new Error(`no recorded response for ${path}`);
    return new Response(JSON.stringify(rec(name).body), { status: rec(name).status });
  }) as typeof globalThis.fetch;
  return { client: new LiveGoogleClient({ getAccessToken: async () => "tok", fetch }), seen };
}

const ACCOUNT = "accounts/100000000000000000001";
const LOCATION = "locations/1000000000000000001";
const PARENT = `${ACCOUNT}/${LOCATION}`;

describe("LiveGoogleClient against recorded live responses", () => {
  it("has all 17 recordings (canary)", () => {
    console.log(`live fixtures: ${recorded.size}`);
    expect(recorded.size).toBe(17);
  });

  it("accounts and locations map with the account attached", async () => {
    const { client } = replay();
    const acc = await client.listAccounts();
    expect(acc.accounts.map((a) => [a.name, a.type])).toEqual([[ACCOUNT, "PERSONAL"]]);
    const locs = await client.listLocations(ACCOUNT);
    expect(locs.locations).toHaveLength(1);
    expect(locs.locations[0]).toMatchObject({ name: LOCATION, account: ACCOUNT });
    // Proto3 JSON omits zero minutes: hours arrive as { hours: 10 } with no minutes.
    const loc = await client.getLocation(LOCATION);
    expect(loc.regularHours?.periods?.[0]?.openTime).toEqual({ hours: 10 });
  });

  it("reviews: rating-only reviews have no comment; replies carry Google's moderation state", async () => {
    const { client } = replay();
    const r = await client.listReviews(ACCOUNT, LOCATION);
    expect(r.reviews).toHaveLength(12);
    expect(r.reviews.filter((x) => !x.comment)).toHaveLength(1);
    const states = new Set(r.reviews.map((x) => x.reviewReply?.reviewReplyState));
    expect(states).toEqual(new Set(["APPROVED", "REJECTED"]));
  });

  it("posts, media, customer media (empty body {}), verification, place actions, attributes", async () => {
    const { client } = replay();
    const posts = await client.listLocalPosts(PARENT);
    expect(posts.localPosts.length).toBeGreaterThan(0);
    expect(posts.nextPageToken).toBe("NEXT_PAGE_TOKEN");
    expect((await client.listMedia(PARENT)).mediaItems.length).toBeGreaterThan(0);
    expect((await client.listCustomerMedia(PARENT)).mediaItems).toEqual([]);
    expect(await client.getVoiceOfMerchantState(LOCATION)).toMatchObject({
      hasVoiceOfMerchant: true,
    });
    const v = await client.listVerifications(LOCATION);
    expect(v.verifications.map((x) => [x.method, x.state])).toEqual([["AUTO", "COMPLETED"]]);
    const links = await client.listPlaceActionLinks(LOCATION);
    expect(links.placeActionLinks.map((l) => l.placeActionType)).toEqual(["APPOINTMENT"]);
    const attrs = await client.getAttributes(`${LOCATION}/attributes`);
    expect(attrs.attributes?.length).toBeGreaterThan(0);
  });

  it("daily metrics: zero days arrive without `value` and map to 0", async () => {
    const { client } = replay();
    const res = await client.fetchDailyMetrics(LOCATION, DAILY_METRICS, "2026-07-20", "2026-10-17");
    const points = res.series.flatMap((s) => s.points);
    expect(points.length).toBeGreaterThan(0);
    expect(points.some((p) => p.value === 0)).toBe(true);
    expect(points.every((p) => Number.isInteger(p.value))).toBe(true);
  });

  it("search keywords: low-volume months come as a threshold, not a value", async () => {
    const { client } = replay();
    const res = await client.listMonthlySearchKeywords(LOCATION, "2026-08", "2026-08");
    expect(res.keywords.some((k) => k.threshold !== undefined && k.value === undefined)).toBe(true);
    expect(res.keywords.some((k) => k.value !== undefined)).toBe(true);
  });
});

describe("detectGoogleSuggestion on a real GOOGLE_UPDATE answer", () => {
  // Recorded with the app's profile readMask. Google's mask was "metadata,serviceItems", but the
  // service items were the same 268 entries in another order, and metadata is output-only: no
  // suggestion. Reporting either would leave a phantom "Google suggested" change open forever.
  it("ignores output-only metadata and a reordered service list (real mask: metadata,serviceItems)", async () => {
    expect((rec("google-updated-profile").body as { diffMask: string }).diffMask).toBe(
      "metadata,serviceItems",
    );
    const { client } = replay((path) =>
      path.endsWith(":getGoogleUpdated")
        ? "google-updated-profile"
        : path.endsWith(LOCATION)
          ? "location-get-profile"
          : undefined,
    );
    expect(await detectGoogleSuggestion(client, LOCATION)).toBeNull();
  });
});
