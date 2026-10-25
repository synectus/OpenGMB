import { describe, expect, it } from "vitest";
import { descriptionProblems, keywordsCovered, looksDuplicate, phoneKey, similarity } from "./similarity";

describe("keywordsCovered", () => {
  it("matches terms whose meaningful words are all present (plurals folded)", () => {
    const r = keywordsCovered("Family dentists offering teeth whitening in Austin", [
      "dentist near me",
      "teeth whitening",
      "emergency dentist",
    ]);
    expect(r.covered).toEqual(["dentist near me", "teeth whitening"]);
    expect(r.missing).toEqual(["emergency dentist"]);
    console.log(`keywordsCovered: ${r.covered.length} covered, ${r.missing.length} missing`);
  });
});

describe("descriptionProblems", () => {
  const good = "We are a friendly family clinic serving the neighbourhood since 2001. ".repeat(4);
  it("passes a normal description", () => expect(descriptionProblems(good)).toEqual([]));
  it("flags short, shouting and stuffed text", () => {
    expect(descriptionProblems("Short text")[0]).toMatch(/only 10 characters/);
    expect(descriptionProblems(good.toUpperCase()).join()).toMatch(/capital/);
    expect(descriptionProblems(good + " dentist dentist dentist dentist dentist").join()).toMatch(/stuffing/);
  });
});

describe("duplicates", () => {
  const a = { name: "Ace Dental", address: "12 Main St, Austin TX", phone: "+1 (512) 555-0100" };
  it("phoneKey ignores punctuation and country code", () => {
    expect(phoneKey("+1 (512) 555-0100")).toBe(phoneKey("512.555.0100"));
    expect(phoneKey("123")).toBeNull();
  });
  it("similarity is 1 for equal text, low for different", () => {
    expect(similarity("Ace Dental", "ace  dental")).toBe(1);
    expect(similarity("Ace Dental", "Blue Plumbing")).toBeLessThan(0.3);
  });
  it("fail fixture: near-identical name and same address", () => {
    expect(looksDuplicate(a, { name: "Ace Dental Clinic", address: "12 Main Street, Austin TX", phone: null })).toBe(true);
  });
  it("fail fixture: renamed listing with same address and phone", () => {
    expect(looksDuplicate(a, { name: "Smile Hub", address: "12 Main St, Austin TX", phone: "5125550100" })).toBe(true);
  });
  it("pass fixtures: shared phone only, shared building only, different branch", () => {
    expect(looksDuplicate(a, { name: "Blue Plumbing", address: "9 Oak Ave, Dallas TX", phone: "5125550100" })).toBe(false);
    expect(looksDuplicate(a, { name: "Blue Plumbing", address: "12 Main St, Austin TX", phone: null })).toBe(false);
    expect(looksDuplicate(a, { name: "Ace Dental", address: "400 Elm Rd, Dallas TX", phone: "2145550199" })).toBe(false);
  });
});
