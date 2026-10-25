import { describe, expect, it } from "vitest";
import { computeDiff, desiredValues, profileFieldsInput, snapshotFromGoogle } from "./profile/fields";
import type { GoogleLocation } from "./google/client";

const price = { currencyCode: "USD", units: "49", nanos: 500_000_000 };
const item = (p?: typeof price) => ({
  freeFormServiceItem: { category: "categories/gcid:a", label: { displayName: "Consult" } },
  ...(p ? { price: p } : {}),
});
const google = (items: unknown[]) => ({ serviceItems: items }) as unknown as GoogleLocation;

describe("service item price", () => {
  it("survives the zod schema", () => {
    const parsed = profileFieldsInput.parse({ serviceItems: [item(price)] });
    expect(parsed.serviceItems?.[0]?.price).toEqual(price);
  });

  it("is kept by the normaliser, for free-form and structured items", () => {
    const d = desiredValues({
      serviceItems: [
        item(price),
        { structuredServiceItem: { serviceTypeId: "job_type_id:x", description: "d" }, price },
      ],
    });
    const out = d.fields.serviceItems as { price?: unknown }[];
    expect(out).toHaveLength(2);
    expect(out.every((i) => JSON.stringify(i.price) === JSON.stringify(price))).toBe(true);
  });

  it("a price-only edit is a change on serviceItems", () => {
    const current = snapshotFromGoogle(google([item(price)]), null);
    const desired = desiredValues({ serviceItems: [item({ ...price, units: "50" })] });
    const diff = computeDiff(current, desired);
    expect(diff.changes.map((c) => c.field)).toEqual(["serviceItems"]);
    expect(diff.updateMask).toEqual(["serviceItems"]);
  });

  it("removing a price is a change; the same price is not", () => {
    const current = snapshotFromGoogle(google([item(price)]), null);
    expect(computeDiff(current, desiredValues({ serviceItems: [item()] })).changes).toHaveLength(1);
    expect(computeDiff(current, desiredValues({ serviceItems: [item(price)] })).changes).toHaveLength(0);
  });

  it("rejects values outside google.type.Money", () => {
    const bad = (p: object) =>
      profileFieldsInput.safeParse({ serviceItems: [{ ...item(), price: p }] }).success;
    expect(bad({ currencyCode: "usd", units: "1" })).toBe(false);
    expect(bad({ currencyCode: "USD", units: "1.5" })).toBe(false);
    expect(bad({ currencyCode: "USD", nanos: 1_000_000_000 })).toBe(false);
    expect(bad({ currencyCode: "USD", nanos: 0.5 })).toBe(false);
    expect(bad({ currencyCode: "USD", units: "1", nanos: -5 })).toBe(false);
    expect(bad({ currencyCode: "USD", units: "-1", nanos: -5 })).toBe(true);
    expect(bad({ currencyCode: "USD", units: "0", nanos: -5 })).toBe(true);
  });
});
