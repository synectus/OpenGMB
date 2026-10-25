import { describe, expect, it } from "vitest";
import { defaultDensity, parseDensity, parseTheme } from "./preferences";

describe("parseTheme", () => {
  it("accepts the three themes and falls back to system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme("purple")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });
});

describe("parseDensity", () => {
  it("accepts compact and comfortable, null otherwise (null means: use the default)", () => {
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("comfortable")).toBe("comfortable");
    expect(parseDensity("cosy")).toBeNull();
    expect(parseDensity(undefined)).toBeNull();
  });
});

describe("defaultDensity", () => {
  it("is comfortable up to 3 active locations, compact from 4", () => {
    expect(defaultDensity(0)).toBe("comfortable");
    expect(defaultDensity(3)).toBe("comfortable");
    expect(defaultDensity(4)).toBe("compact");
  });
});
