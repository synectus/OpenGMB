// packages/core/src/review-links/pure.test.ts
import { describe, expect, it } from "vitest";
import { clip, googleReviewUrl, isLikelyBot, parseSource, shortName, slugBase, uniqueSlug, widgetNote, PLACE_ID } from "./pure";

describe("slugBase and uniqueSlug", () => {
  it("canary", () => {
    expect(slugBase("Rivermoor Main St")).toBe("rivermoor-main-st");
    expect(slugBase("Café Münster, #2!")).toBe("cafe-munster-2");
    expect(slugBase("!!")).toBe("location");
    expect(slugBase("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
  it("adds a suffix only when taken, and gives up after 10 tries", async () => {
    expect(await uniqueSlug("Rivermoor Main", async () => false)).toBe("rivermoor-main");
    let i = 0;
    expect(await uniqueSlug("Rivermoor Main", async (s) => s === "rivermoor-main", () => `r${i++}`)).toBe("rivermoor-main-r0");
    await expect(uniqueSlug("x y", async () => true, () => "zz")).rejects.toThrow(/slug/i);
  });
});

describe("googleReviewUrl and PLACE_ID", () => {
  it("builds Google's review form URL and encodes the id", () => {
    expect(googleReviewUrl("ChIJabc_123-xyz")).toBe("https://search.google.com/local/writereview?placeid=ChIJabc_123-xyz");
    expect(PLACE_ID.test("ChIJabc_123-xyz")).toBe(true);
    expect(PLACE_ID.test("short")).toBe(false);
    expect(PLACE_ID.test("has space in it 123")).toBe(false);
  });
});

describe("parseSource and isLikelyBot", () => {
  it("unknown or missing source is a plain link", () => {
    expect(parseSource("qr")).toBe("qr");
    expect(parseSource("sms")).toBe("sms");
    expect(parseSource("EMAIL")).toBe("link");
    expect(parseSource(null)).toBe("link");
    expect(parseSource("<script>")).toBe("link");
  });
  it("canary: robots and preview fetchers are not counted, browsers are", () => {
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "WhatsApp/2.23", "facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "curl/8.4.0", "Mozilla/5.0 (Macintosh) HeadlessChrome/120", "Mozilla/5.0 Google-PageRenderer", "Twitterbot/1.0", "SkypeUriPreview", "", null]) {
      expect(isLikelyBot(ua), String(ua)).toBe(true);
    }
    for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", "Mozilla/5.0 smoke"]) {
      expect(isLikelyBot(ua), ua).toBe(false);
    }
  });
});

describe("widgetNote", () => {
  it("canary: the board sentence", () => {
    expect(widgetNote(4, "grid")).toBe("Showing reviews rated 4★ and up · from Google");
    expect(widgetNote(5, "carousel")).toBe("Showing reviews rated 5★ and up · from Google");
  });
  it("never claims to show all reviews", () => {
    for (const min of [1, 2, 3, 4, 5]) for (const layout of ["grid", "list", "carousel", "badge"] as const) {
      expect(widgetNote(min, layout).toLowerCase(), `${min} ${layout}`).not.toMatch(/\ball\b/);
    }
    expect(widgetNote(1, "grid")).toBe("Showing a selection of recent reviews · from Google");
    expect(widgetNote(4, "badge")).toBe("Rating from Google");
  });
});

describe("shortName and clip", () => {
  it("first name and last initial; anonymous and empty are generic", () => {
    expect(shortName("Dana Whitfield", false)).toBe("Dana W.");
    expect(shortName("Dana", false)).toBe("Dana");
    expect(shortName("Mary Ann van der Berg", false)).toBe("Mary B.");
    expect(shortName("Dana Whitfield", true)).toBe("A Google user");
    expect(shortName(null, false)).toBe("A Google user");
  });
  it("clip collapses whitespace and cuts with an ellipsis", () => {
    expect(clip("a\n\n  b", 10)).toBe("a b");
    expect(clip("x".repeat(300), 240)).toHaveLength(240);
    expect(clip("x".repeat(300), 240).endsWith("…")).toBe(true);
  });
});
