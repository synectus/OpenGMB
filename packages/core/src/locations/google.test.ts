import { describe, expect, it } from "vitest";
import type { GoogleLocation } from "../google/client";
import { hasVoiceOfMerchant, IMPORT_READ_MASK } from "./google";

const loc = (metadata?: GoogleLocation["metadata"]) => ({ name: "locations/1", title: "A", ...(metadata ? { metadata } : {}) }) as GoogleLocation;

describe("hasVoiceOfMerchant", () => {
  it("is true when Google says so", () => expect(hasVoiceOfMerchant(loc({ hasVoiceOfMerchant: true }))).toBe(true));
  it("is false when metadata is present but the field is omitted (proto3 JSON drops false)", () => {
    expect(hasVoiceOfMerchant(loc({ placeId: "p" }))).toBe(false);
    expect(hasVoiceOfMerchant(loc({ hasVoiceOfMerchant: false }))).toBe(false);
  });
  it("is null when there is no metadata at all", () => expect(hasVoiceOfMerchant(loc())).toBeNull());
  it("is requested by the import read mask", () => expect(IMPORT_READ_MASK.split(",")).toContain("metadata"));
});
