import { describe, expect, it } from "vitest";
import { googleReviewUrl } from "../review-links/pure";
import { GOOGLE_REVIEW_LINK, REVIEW_LINK_FACTS, REVIEW_LINK_TOOL, monthlyCostAtCapUsd, reviewLinkSearchMode } from "./review-link-tool";
import { PLACES_PRICING } from "./places";

describe("review link tool config", () => {
  it("every external fact has a source and a date", () => {
    expect(REVIEW_LINK_FACTS.length).toBeGreaterThan(0); // fail on zero
    for (const f of REVIEW_LINK_FACTS) {
      expect(f.sourceUrl).toMatch(/^https:\/\/\S+$/);
      expect(f.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const f of [GOOGLE_REVIEW_LINK]) {
      expect(["verified", "unverified"]).toContain(f.status);
      expect(f.note.length).toBeGreaterThan(10);
    }
    console.log(`${REVIEW_LINK_FACTS.length} facts checked`);
  });
  it("canary: the link is the format production already uses", () => {
    expect(googleReviewUrl("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe("https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(GOOGLE_REVIEW_LINK.template).toContain("{placeId}");
  });
  it("the global cap keeps a 31-day month inside the free allowance", () => {
    const free = PLACES_PRICING.autocompleteRequests.freePerMonth!;
    expect(REVIEW_LINK_TOOL.globalPerDay).toBe(Math.floor(free / 31));
    expect(REVIEW_LINK_TOOL.globalPerDay * 31).toBeLessThanOrEqual(free);
    console.log(
      `global cap ${REVIEW_LINK_TOOL.globalPerDay}/day; cost at the cap: $${monthlyCostAtCapUsd({ freeTierAvailable: true }).toFixed(2)}/month inside the free tier, $${monthlyCostAtCapUsd({ freeTierAvailable: false }).toFixed(2)}/month if another feature used the free tier up`,
    );
    expect(monthlyCostAtCapUsd({ freeTierAvailable: true })).toBe(0);
    expect(monthlyCostAtCapUsd({ freeTierAvailable: false })).toBeGreaterThan(0); // canary: the math runs
  });
  it("per-IP caps are below the global cap", () => {
    expect(REVIEW_LINK_TOOL.perIpPerDay).toBeLessThan(REVIEW_LINK_TOOL.globalPerDay);
    expect(REVIEW_LINK_TOOL.perIpPerMinute).toBeLessThanOrEqual(REVIEW_LINK_TOOL.perIpPerDay);
  });
  it("search is off without a key, and fixture only when asked for and not in production", () => {
    expect(reviewLinkSearchMode({}, false)).toBe("off");
    expect(reviewLinkSearchMode({}, true)).toBe("live");
    expect(reviewLinkSearchMode({ PLACES_API_MODE: "fixture" }, false)).toBe("fixture");
    expect(reviewLinkSearchMode({ PLACES_API_MODE: "fixture", NODE_ENV: "production" }, false)).toBe("off");
  });
});
