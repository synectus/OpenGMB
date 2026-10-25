import { describe, expect, it } from "vitest";
import {
  checkCoords,
  keyStatusLine,
  monthLabel,
  parseKeywords,
  priceLine,
  usageRows,
  usdPrecise,
} from "./tracker-setup";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("parseKeywords", () => {
  it("splits on commas, trims, drops blanks", () => {
    expect(parseKeywords(" pain clinic rivermoor, pain management near me ,, ")).toEqual({
      keywords: ["pain clinic rivermoor", "pain management near me"],
      error: null,
    });
  });
  it("flags case-insensitive duplicates and more than five", () => {
    expect(parseKeywords("a, A").error).toBe("Each keyword can appear once.");
    expect(parseKeywords("a,b,c,d,e,f").error).toBe("Up to 5 keywords.");
    expect(parseKeywords("").error).toBe("Add at least one keyword.");
  });
});

describe("checkCoords", () => {
  it("accepts decimal degrees and rejects the rest with a plain message", () => {
    expect(checkCoords("27.5306", "-99.4803")).toBeNull();
    expect(checkCoords("", "-99.48")).toBe("Type the centre latitude and longitude.");
    expect(checkCoords("abc", "1")).toBe("Latitude and longitude must be numbers, like 27.5306.");
    expect(checkCoords("86", "0")).toBe("Latitude must be between -85 and 85.");
    expect(checkCoords("0", "181")).toBe("Longitude must be between -180 and 180.");
  });
});

describe("text", () => {
  it("prices per task keep four decimals", () => {
    expect(usdPrecise(0.0006)).toBe("$0.0006");
  });
  it("the price line says verified only when it is", () => {
    expect(
      priceLine({ id: "dataforseo_standard", perTaskUsd: 0.0006, priceVerifiedOn: "2026-10-12", priceStatus: "verified" }),
    ).toBe("DataForSEO price $0.0006 per task, verified 2026-10-12.");
    expect(
      priceLine({ id: "places_relevance", perTaskUsd: 0, priceVerifiedOn: "2026-10-12", priceStatus: "unverified" }),
    ).toBe("Relevance check: no charge per task (price not verified, last checked 2026-10-12).");
  });
  it("months read like the board", () => {
    expect(monthLabel("2026-05")).toBe("May 2026");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
  it("the key status line covers no key, unverified and verified", () => {
    expect(keyStatusLine({ configured: false, login: null, lastVerifiedAt: null }, utc)).toBe(
      "No key set: runs use our key with the markup.",
    );
    expect(keyStatusLine({ configured: true, login: "me@x.test", lastVerifiedAt: null }, utc)).toBe(
      "Key for me@x.test. Not verified yet.",
    );
    expect(
      keyStatusLine({ configured: true, login: "me@x.test", lastVerifiedAt: "2026-10-16T10:20:00.000Z" }, utc),
    ).toBe("Key for me@x.test. Verified 2026-10-16 10:20.");
    expect(
      keyStatusLine({ configured: true, login: "me@x.test", lastVerifiedAt: "2026-10-16T10:20:00.000Z" }, ist),
    ).toBe("Key for me@x.test. Verified 16/10/2026 15:50.");
  });
});

describe("usageRows", () => {
  const b = (runs: number, charged = 0) => ({ runs, points: runs * 49, tasks: runs * 98, costAtDataforseoUsd: charged / 1.28, chargedUsd: charged });
  it("one row per used key per month, oldest first, money in two decimals (denominator)", () => {
    const rows = usageRows([
      { month: "2026-05", byo: b(0), resold: b(12, 0.9), total: b(12, 0.9) },
      { month: "2026-06", byo: b(2, 0.1), resold: b(18, 1.35), total: b(20, 1.45) },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.month, r.key])).toEqual([
      ["May 2026", "Our key (with markup)"],
      ["June 2026", "Your key (at cost)"],
      ["June 2026", "Our key (with markup)"],
    ]);
    expect(rows[0]).toMatchObject({ runs: 12, points: "588", tasks: "1,176", charged: "$0.90" });
  });
});
