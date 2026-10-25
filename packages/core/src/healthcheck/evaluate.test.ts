import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GoogleLocation } from "../google/client";
import { CHECK_IDS, evaluateHealth, scoreOf, type HealthInput, type Src } from "./evaluate";

const NOW = new Date("2026-10-18T12:00:00Z");
const ID = "11111111-1111-4111-8111-111111111111";
const ok = <T>(value: T): Src<T> => ({ ok: true, value });
const bad: Src<never> = { ok: false };
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../google/fixtures/live/${name}.json`, import.meta.url), "utf8"))
    .body;

const GOOD_LOCATION: GoogleLocation = {
  name: "locations/1",
  title: "Clinic",
  profile: { description: "We are a friendly dentist clinic serving the neighbourhood since 2001. Our team offers teeth whitening, cleanings and check-ups for the whole family, with evening and weekend appointments, a calm waiting room and clear prices explained before any treatment starts." },
  categories: {
    primaryCategory: { name: "categories/gcid:dentist" },
    additionalCategories: [{ name: "categories/gcid:orthodontist" }],
  },
  regularHours: {
    periods: [
      { openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } },
    ],
  },
  specialHours: {
    specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }],
  },
  phoneNumbers: { primaryPhone: "+1 555 010 0000" },
  websiteUri: "https://example.test/?utm_source=google&utm_medium=organic",
  serviceItems: [{ freeFormServiceItem: { category: "c", label: { displayName: "Cleaning" } } }],
};

const photo = (category: string, createTime: string) => ({
  mediaFormat: "PHOTO" as const,
  locationAssociation: { category },
  createTime,
});

// Four profiled competitors; the good location (Dentist + Orthodontist) matches them. WHITENER_RIVALS also use "Teeth whitener".
const RIVALS = [
  { primary: "Dentist", additional: ["Orthodontist"], ids: [] },
  { primary: "Dentist", additional: ["Orthodontist"], ids: [] },
  { primary: "Dentist", additional: [], ids: [] },
  { primary: "Dentist", additional: ["Orthodontist"], ids: [] },
];
const WHITENER_RIVALS = RIVALS.map((r, i) => (i < 2 ? { ...r, additional: [...r.additional, "Teeth whitener"] } : r));

function good(over: Partial<HealthInput> = {}): HealthInput {
  return {
    locationId: ID,
    location: ok(GOOD_LOCATION),
    media: ok([
      photo("PROFILE", "1970-01-01T00:00:00Z"),
      photo("COVER", daysAgo(100)),
      ...Array.from({ length: 9 }, (_, i) => photo("ADDITIONAL", daysAgo(i + 1))),
    ]),
    posts: ok([{ topicType: "STANDARD", state: "LIVE", createTime: daysAgo(2) }]),
    voice: ok({ hasVoiceOfMerchant: true, hasBusinessAuthority: true }),
    links: ok([{ uri: "https://example.test/book", placeActionType: "APPOINTMENT" }]),
    attributes: ok([{ name: "attributes/has_onsite_parking", values: [true] }]),
    keywords: ["dentist", "teeth whitening"],
    listing: { name: "Clinic", address: "1 High St, Leeds", phone: "+44 113 496 0000" },
    others: [],
    competitors: { dataSource: "live", rows: RIVALS },
    reviews: { unreplied: 0, waitingToPublish: 0, total: 20, avgRating: 4.6, newInWindow: 3 },
    ...over,
  };
}

const find = (input: HealthInput, id: string) => {
  const c = evaluateHealth(input, NOW).find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};
const status = (input: HealthInput, id: string) => find(input, id).status;
const loc = (patch: Partial<GoogleLocation>): Partial<HealthInput> => ({
  location: ok({ ...GOOD_LOCATION, ...patch }),
});

describe("evaluateHealth", () => {
  it("builds exactly the CHECK_IDS, in order (the UI says 24 checks)", () => {
    const ids = evaluateHealth(good(), NOW).map((c) => c.id);
    console.log(`CHECK_IDS: ${CHECK_IDS.length}`);
    expect(CHECK_IDS).toHaveLength(24);
    expect(ids).toEqual([...CHECK_IDS]);
    // A failed read must not drop checks either.
    expect(evaluateHealth(good({ location: bad, media: bad, posts: bad }), NOW).map((c) => c.id)).toEqual([...CHECK_IDS]);
  });
  it("a complete listing passes every check (canary: checks were evaluated)", () => {
    const checks = evaluateHealth(good(), NOW);
    console.log(`healthcheck checks: ${checks.length}`);
    expect(checks.length).toBeGreaterThanOrEqual(24);
    expect(checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual([]);
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    expect(new Set(checks.map((c) => c.importance))).toEqual(
      new Set(["necessary", "important", "nice"]),
    );
  });

  it("every failing check names a fix link inside the app, except where none exists", () => {
    const empty = good({
      ...loc({
        profile: undefined,
        categories: undefined,
        regularHours: undefined,
        specialHours: undefined,
        phoneNumbers: undefined,
        websiteUri: undefined,
        serviceItems: undefined,
      }),
      media: ok([]),
      posts: ok([]),
      voice: ok({}),
      links: ok([]),
      attributes: ok([]),
      reviews: { unreplied: 4, waitingToPublish: 0, total: 5, avgRating: 2.5, newInWindow: 0 },
    });
    const failing = evaluateHealth(empty, NOW).filter((c) => c.status === "fail");
    expect(failing.length).toBeGreaterThanOrEqual(19);
    for (const c of failing) {
      if (c.fix) expect(c.fix.href).toMatch(/^\/(locations|posts|reviews|settings)/);
      expect(c.detail.length).toBeGreaterThan(0);
    }
    expect(find(empty, "unreplied_reviews").fix?.href).toBe(`/reviews?replied=no&loc=${ID}`);
    expect(find(empty, "recent_post").fix?.href).toBe("/posts?view=compose");
    expect(find(empty, "photo_count").fix?.href).toBe(`/locations/${ID}/media`);
    expect(find(empty, "primary_category").fix?.href).toBe(`/locations/${ID}/profile`);
  });

  describe("description", () => {
    it("missing fails; blank counts as missing", () => {
      expect(status(good(loc({ profile: undefined })), "description")).toBe("fail");
      expect(status(good(loc({ profile: { description: "   " } })), "description")).toBe("fail");
    });
    it("over the configured max fails", () => {
      const c = find(good(loc({ profile: { description: "a".repeat(751) } })), "description");
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("751");
      expect(c.detail).toContain("750");
    });
    it("counts code points, not UTF-16 units", () => {
      // 750 emoji = 1500 UTF-16 units but 750 code points: within the limit.
      expect(status(good(loc({ profile: { description: "😀".repeat(750) } })), "description")).toBe(
        "pass",
      );
    });
    it.each([
      "Visit https://example.test today",
      "see www.example.test",
      "book at example.com now",
    ])("a link fails: %s", (d) => {
      expect(status(good(loc({ profile: { description: d } })), "description")).toBe("fail");
    });
    it("unknown when the location could not be read", () => {
      expect(status(good({ location: bad }), "description")).toBe("unknown");
    });
  });

  describe("categories", () => {
    it("primary missing fails; additional missing fails separately", () => {
      const only = { categories: { primaryCategory: { name: "categories/gcid:dentist" } } };
      expect(status(good(loc(only)), "primary_category")).toBe("pass");
      expect(status(good(loc(only)), "additional_categories")).toBe("fail");
      expect(status(good(loc({ categories: {} })), "primary_category")).toBe("fail");
    });
  });

  describe("hours", () => {
    it("regular hours: none fails, empty periods fails", () => {
      expect(status(good(loc({ regularHours: undefined })), "regular_hours")).toBe("fail");
      expect(status(good(loc({ regularHours: { periods: [] } })), "regular_hours")).toBe("fail");
    });
    it("recorded live shape: hours without minutes, and open at midnight as {}, count as set", () => {
      const live = fixture("location-get") as GoogleLocation;
      expect(live.regularHours?.periods?.[0]?.openTime).toEqual({ hours: 10 });
      expect(status(good({ location: ok(live) }), "regular_hours")).toBe("pass");
      const midnight: GoogleLocation["regularHours"] = {
        periods: [{ openDay: "MONDAY", openTime: {}, closeDay: "MONDAY", closeTime: { hours: 1 } }],
      };
      expect(status(good(loc({ regularHours: midnight })), "regular_hours")).toBe("pass");
    });
    it("special hours: only upcoming dates count", () => {
      const past = { specialHourPeriods: [{ startDate: { year: 2026, month: 1, day: 1 } }] };
      expect(status(good(loc({ specialHours: past })), "special_hours")).toBe("fail");
      expect(status(good(loc({ specialHours: undefined })), "special_hours")).toBe("fail");
      const today = { specialHourPeriods: [{ startDate: { year: 2026, month: 10, day: 18 } }] };
      expect(status(good(loc({ specialHours: today })), "special_hours")).toBe("pass");
      const partial = { specialHourPeriods: [{ startDate: { year: 2026 } }] };
      expect(status(good(loc({ specialHours: partial })), "special_hours")).toBe("fail");
    });
  });

  describe("phone and website", () => {
    it("phone and website missing fail", () => {
      expect(status(good(loc({ phoneNumbers: {} })), "phone")).toBe("fail");
      expect(status(good(loc({ phoneNumbers: undefined })), "phone")).toBe("fail");
      expect(status(good(loc({ websiteUri: undefined })), "website")).toBe("fail");
    });
    it("UTM: present passes, absent or unparseable fails", () => {
      expect(status(good(loc({ websiteUri: "https://example.test/" })), "website_utm")).toBe(
        "fail",
      );
      expect(status(good(loc({ websiteUri: "not a url" })), "website_utm")).toBe("fail");
      expect(
        status(good(loc({ websiteUri: "https://example.test/?utm_campaign=x" })), "website_utm"),
      ).toBe("pass");
    });
  });

  describe("photos", () => {
    it("count below the threshold fails, with the numbers in the detail", () => {
      const c = find(good({ media: ok([photo("ADDITIONAL", daysAgo(1))]) }), "photo_count");
      expect(c.status).toBe("fail");
      expect(c.detail).toBe("1 photo, recommended at least 10");
    });
    it("videos are not photos", () => {
      const media = [
        ...Array.from({ length: 9 }, () => photo("ADDITIONAL", daysAgo(1))),
        { mediaFormat: "VIDEO" as const, createTime: daysAgo(1) },
      ];
      expect(status(good({ media: ok(media) }), "photo_count")).toBe("fail");
    });
    it("recent photo: window edge and the profile photo's epoch createTime", () => {
      const old = ok([photo("PROFILE", "1970-01-01T00:00:00Z"), photo("ADDITIONAL", daysAgo(31))]);
      expect(status(good({ media: old }), "recent_photo")).toBe("fail");
      const edge = ok([photo("ADDITIONAL", daysAgo(30))]);
      expect(status(good({ media: edge }), "recent_photo")).toBe("pass");
    });
    it("logo and cover are separate checks", () => {
      const media = ok([photo("COVER", daysAgo(1))]);
      expect(status(good({ media }), "logo_photo")).toBe("fail");
      expect(status(good({ media }), "cover_photo")).toBe("pass");
    });
    it("recorded live media list evaluates (no crash on real shapes)", () => {
      const live = fixture("media-list");
      const c = find(good({ media: ok(live.mediaItems) }), "photo_count");
      expect(["pass", "fail"]).toContain(c.status);
      expect(c.detail).toMatch(/^\d+ photos?, recommended at least 10$/);
    });
    it("unknown when media could not be read: all four photo checks", () => {
      for (const id of ["photo_count", "recent_photo", "logo_photo", "cover_photo"]) {
        expect(status(good({ media: bad }), id)).toBe("unknown");
      }
    });
  });

  describe("posts", () => {
    it("recent live post passes; an old one or none fails", () => {
      expect(status(good({ posts: ok([]) }), "recent_post")).toBe("fail");
      const old = ok([
        { topicType: "STANDARD" as const, state: "LIVE" as const, createTime: daysAgo(8) },
      ]);
      expect(status(good({ posts: old }), "recent_post")).toBe("fail");
      const edge = ok([
        { topicType: "STANDARD" as const, state: "LIVE" as const, createTime: daysAgo(7) },
      ]);
      expect(status(good({ posts: edge }), "recent_post")).toBe("pass");
    });
    it("a rejected post is not published", () => {
      const rejected = ok([
        { topicType: "STANDARD" as const, state: "REJECTED" as const, createTime: daysAgo(1) },
      ]);
      expect(status(good({ posts: rejected }), "recent_post")).toBe("fail");
    });
    it("newest is found whatever the page order; recorded live posts evaluate", () => {
      const live = fixture("local-posts-list");
      const reversed = [...live.localPosts].reverse();
      expect(find(good({ posts: ok(live.localPosts) }), "recent_post").detail).toBe(
        find(good({ posts: ok(reversed) }), "recent_post").detail,
      );
    });
    it("unknown on read failure", () => {
      expect(status(good({ posts: bad }), "recent_post")).toBe("unknown");
    });
  });

  describe("reviews", () => {
    it("unreplied: zero passes, any fails", () => {
      expect(status(good(), "unreplied_reviews")).toBe("pass");
      const c = find(
        good({ reviews: { unreplied: 2, waitingToPublish: 0, total: 9, avgRating: 4.5, newInWindow: 1 } }),
        "unreplied_reviews",
      );
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("2");
    });
    it("average rating: threshold edge, and unknown with no reviews", () => {
      const r = (avgRating: number | null, total = 5) => ({
        unreplied: 0, waitingToPublish: 0,
        total,
        avgRating,
        newInWindow: 1,
      });
      expect(status(good({ reviews: r(4.0) }), "average_rating")).toBe("pass");
      expect(status(good({ reviews: r(3.99) }), "average_rating")).toBe("fail");
      expect(status(good({ reviews: r(null, 0) }), "average_rating")).toBe("unknown");
    });
    it("new review in the window", () => {
      expect(
        status(
          good({ reviews: { unreplied: 0, waitingToPublish: 0, total: 5, avgRating: 5, newInWindow: 0 } }),
          "new_reviews",
        ),
      ).toBe("fail");
      expect(find(good(), "new_reviews").fix).toBeNull();
    });
  });

  describe("google-only checks", () => {
    it("verification: voice of merchant passes; without it fails with the standing", () => {
      expect(status(good(), "verification")).toBe("pass");
      const c = find(
        good({ voice: ok({ verify: { hasPendingVerification: false } }) }),
        "verification",
      );
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("verify");
      expect(status(good({ voice: bad }), "verification")).toBe("unknown");
    });
    it("recorded live voice of merchant passes", () => {
      expect(status(good({ voice: ok(fixture("voice-of-merchant")) }), "verification")).toBe(
        "pass",
      );
    });
    it("place action link, attributes, service items", () => {
      expect(status(good({ links: ok([]) }), "place_action_link")).toBe("fail");
      expect(status(good({ links: bad }), "place_action_link")).toBe("unknown");
      expect(status(good({ attributes: ok([]) }), "attributes")).toBe("fail");
      expect(status(good({ attributes: ok(fixture("attributes").attributes) }), "attributes")).toBe(
        "pass",
      );
      expect(status(good({ attributes: bad }), "attributes")).toBe("unknown");
      expect(status(good(loc({ serviceItems: [] })), "service_items")).toBe("fail");
    });
  });

  describe("scoreOf", () => {
    it("counts only pass and fail; unknown is excluded from the total", () => {
      const checks = evaluateHealth(good({ posts: bad, media: bad, voice: ok({}) }), NOW);
      const s = scoreOf(checks);
      const unknown = checks.filter((c) => c.status === "unknown").length;
      const passed = checks.filter((c) => c.status === "pass").length;
      expect(unknown).toBe(5);
      expect(s.total).toBe(checks.length - unknown);
      expect(s.passed).toBe(passed);
      expect(s.percent).toBe(Math.round((passed / s.total) * 100));
    });
    it("no pass/fail checks gives 0 of 0 and 0 percent, not NaN", () => {
      expect(scoreOf([])).toEqual({ passed: 0, total: 0, percent: 0 });
    });
    it("all passing is 100", () => {
      expect(scoreOf(evaluateHealth(good(), NOW)).percent).toBe(100);
    });
    it("skipped checks are left out of the score like unknown ones", () => {
      const checks = evaluateHealth(good(), NOW).map((c, i) =>
        i < 2 ? { ...c, status: "skipped" as const } : c,
      );
      const s = scoreOf(checks);
      expect(s.total).toBe(22);
      expect(s.passed).toBe(22);
    });
  });
});

describe("L7 checks", () => {
  const desc = (d: string) => loc({ profile: { description: d } });
  const GOOD_DESC = GOOD_LOCATION.profile!.description!;
  it("description_quality: passes a full description, fails short, shouting, stuffed, missing; unknown when unread", () => {
    expect(status(good(), "description_quality")).toBe("pass");
    expect(status(good(desc("Dentist.")), "description_quality")).toBe("fail");
    expect(status(good(desc(GOOD_DESC.toUpperCase())), "description_quality")).toBe("fail");
    expect(status(good(desc(GOOD_DESC + " clinic clinic clinic clinic clinic")), "description_quality")).toBe("fail");
    expect(status(good(loc({ profile: undefined })), "description_quality")).toBe("fail");
    expect(status(good({ location: bad }), "description_quality")).toBe("unknown");
    expect(find(good(desc("Dentist.")), "description_quality").fix?.href).toBe(`/locations/${ID}/profile`);
  });
  it("description_keywords: pass when top terms appear, fail naming the missing ones, unknown without data", () => {
    expect(status(good(), "description_keywords")).toBe("pass");
    const miss = find(good({ keywords: ["emergency plumber", "boiler repair", "drain"] }), "description_keywords");
    expect(miss.status).toBe("fail");
    expect(miss.detail).toContain('"boiler repair"');
    expect(miss.fix?.href).toBe(`/locations/${ID}/profile`);
    expect(status(good({ keywords: [] }), "description_keywords")).toBe("unknown");
    expect(status(good({ location: bad }), "description_keywords")).toBe("unknown");
  });
  it("duplicate_listing: fails on a near-identical sibling and links to it, passes otherwise", () => {
    const twin = { id: "22222222-2222-4222-8222-222222222222", name: "Clinics", address: "1 High Street, Leeds", phone: null };
    const other = { id: "33333333-3333-4333-8333-333333333333", name: "Garage", address: "9 Low Rd, York", phone: "+44 113 496 0000" };
    expect(status(good({ others: [other] }), "duplicate_listing")).toBe("pass");
    const c = find(good({ others: [other, twin] }), "duplicate_listing");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Clinics");
    expect(c.fix?.href).toBe(`/locations/${twin.id}/profile`);
  });
  it("category_fit: fails on a rarely used primary or a missing popular category; unknown without live competitor data", () => {
    const live = (rows = WHITENER_RIVALS, dataSource: "live" | "sandbox" | "fixture" | null = "live") => ({ competitors: { dataSource, rows } });
    // Teeth whitener is used by 2 of 4 (50%) and the good listing lacks it.
    const lacks = find(good(live()), "category_fit");
    expect(lacks.status).toBe("fail");
    expect(lacks.detail).toContain("Teeth whitener");
    expect(lacks.fix?.href).toBe(`/locations/${ID}/profile`);
    const withIt = loc({ categories: { primaryCategory: { name: "categories/gcid:dentist" }, additionalCategories: [{ name: "categories/gcid:orthodontist" }, { name: "categories/gcid:teeth_whitener" }] } });
    expect(status(good({ ...withIt, ...live() }), "category_fit")).toBe("pass");
    // Primary not used by most competitors.
    const odd = loc({ categories: { primaryCategory: { name: "categories/gcid:veterinarian" }, additionalCategories: [{ name: "categories/gcid:teeth_whitener" }] } });
    const o = find(good({ ...odd, ...live() }), "category_fit");
    expect(o.status).toBe("fail");
    expect(o.detail).toContain("0 of 4");
    // Not enough data is never a pass or a fail.
    expect(status(good(live([])), "category_fit")).toBe("unknown");
    expect(status(good(live(RIVALS.slice(0, 2))), "category_fit")).toBe("unknown");
    expect(status(good(live(WHITENER_RIVALS, "fixture")), "category_fit")).toBe("unknown");
    expect(status(good(live(WHITENER_RIVALS, "sandbox")), "category_fit")).toBe("unknown");
    expect(status(good(live(WHITENER_RIVALS, null)), "category_fit")).toBe("unknown");
    expect(status(good({ ...live(), location: bad }), "category_fit")).toBe("unknown");
    expect(status(good({ ...live(), ...loc({ categories: {} }) }), "category_fit")).toBe("unknown");
  });
});
