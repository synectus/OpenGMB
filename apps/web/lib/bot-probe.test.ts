import { describe, expect, it } from "vitest";
import { isServerActionProbe } from "./bot-probe";

const junk = new TypeError("Failed to parse body as FormData.");

describe("isServerActionProbe", () => {
  it("skips the FormData parse failure on a request with a next-action header", () => {
    expect(isServerActionProbe(junk, { headers: { "next-action": "abc123" } })).toBe(true);
  });
  it("still records the same error without a next-action header (our own code)", () => {
    expect(isServerActionProbe(junk, { headers: {} })).toBe(false);
    expect(isServerActionProbe(junk, undefined)).toBe(false);
  });
  it("still records ordinary errors, even with the header", () => {
    expect(isServerActionProbe(new Error("boom"), { headers: { "next-action": "x" } })).toBe(false);
    expect(isServerActionProbe(new TypeError("Failed to parse body as FormData. extra"), { headers: { "next-action": "x" } })).toBe(false);
    expect(isServerActionProbe(new Error("Failed to parse body as FormData."), { headers: { "next-action": "x" } })).toBe(false);
  });
});
