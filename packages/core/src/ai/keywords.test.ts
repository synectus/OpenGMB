import { describe, expect, it } from "vitest";
import { truncateToLimit } from "./draft";
import { keywordsIn } from "./keywords";

describe("keywordsIn", () => {
  it("finds whole-word, case-insensitive matches and keeps the given spelling", () => {
    const text = "We offer Teeth Whitening, and emergency dentists are on call.";
    expect(keywordsIn(text, ["teeth whitening", "emergency dentist", "braces"])).toEqual([
      "teeth whitening",
      "emergency dentist",
    ]);
  });
  it("does not match inside a longer word, and ignores empty keywords", () => {
    expect(keywordsIn("The bracesmith visits.", ["braces", "", "  "])).toEqual([]);
    expect(keywordsIn("Dentistry for all.", ["dentist"])).toEqual([]);
  });
  it("canary: a keyword that is present is found", () => {
    expect(keywordsIn("Plumber in Leeds.", ["plumber in leeds"])).toEqual(["plumber in leeds"]);
  });
});

describe("truncateToLimit", () => {
  it("returns text within the limit unchanged", () => {
    expect(truncateToLimit("One. Two.", 50)).toBe("One. Two.");
  });
  it("cuts at the last sentence end that fits", () => {
    const text = "First sentence here. Second sentence here. Third sentence here.";
    const out = truncateToLimit(text, 45);
    expect(out).toBe("First sentence here. Second sentence here.");
    expect(Array.from(out).length).toBeLessThanOrEqual(45);
  });
  it("falls back to the last word when no sentence end fits, and never exceeds the limit", () => {
    const out = truncateToLimit("a very long run of words without any full stop at all", 20);
    expect(out).toBe("a very long run of");
    expect(Array.from(truncateToLimit("x".repeat(100), 10)).length).toBe(10);
  });
  it("counts code points, not UTF-16 units", () => {
    const out = truncateToLimit("😀".repeat(30), 10);
    expect(Array.from(out).length).toBe(10);
  });
});
