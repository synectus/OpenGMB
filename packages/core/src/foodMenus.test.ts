import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GoogleApiError } from "./google/errors";
import { isFoodMenuUnsupported } from "./foodMenus/support";
import { PgBoss } from "pg-boss";
import { createDb, locationWriteOps } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ReadOnlyGoogleClient } from "./google/read-only-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { LOCATION_OP_QUEUE, processLocationOp } from "./locationOps/jobs";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const kit = makeKit(db, mock);
const { run } = kit;

type Op = { id: string; status: string; error: string | null; domain: string };
type Menus = Record<string, unknown>[];

const label = (displayName: string) => [{ displayName }];
const menu = (extra: Record<string, unknown> = {}) => ({
  labels: label("Dinner"),
  cuisines: ["ITALIAN"],
  sections: [
    {
      labels: label("Mains"),
      items: [
        {
          labels: label("Margherita"),
          attributes: {
            price: { currencyCode: "USD", units: "12", nanos: 500_000_000 },
            allergen: ["DAIRY"],
            nutritionFacts: { calories: { lowerAmount: 800, unit: "CALORIE" } },
          },
        },
      ],
    },
  ],
  ...extra,
});

let org: Org;
let loc: Loc;
const get = (actor = org.owner) =>
  run<{ supported: boolean; menus: Menus; operations: Op[] }>(actor, "foodMenus.get", { locationId: loc.row.id });
const save = (menus: unknown, actor = org.manager) =>
  run<{ operation: Op }>(actor, "foodMenus.update", { locationId: loc.row.id, menus });
const runOp = (id: string) => processLocationOp(db, { opId: id }, { client });

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(LOCATION_OP_QUEUE);
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("food menus", () => {
  it("round trip on the mock: empty read, queued save, applied, read back unchanged (unknown fields kept)", async () => {
    expect((await get()).menus).toEqual([]);
    const before = mock.callCount;
    const op = (await save([menu()])).operation;
    expect(op).toMatchObject({ status: "pending", domain: "food_menu" });
    expect(mock.callCount).toBe(before); // nothing at Google until the job runs
    expect(await runOp(op.id)).toBe("applied");
    const write = mock.calls.filter((c) => c.method === "updateFoodMenus").at(-1)!;
    expect(write.args[1]).toEqual(["menus"]);
    const back = await get();
    expect(back.menus).toEqual([menu()]);
    expect(back.operations[0]).toMatchObject({ id: op.id, status: "applied" });
    // Removing everything clears the menu.
    const clear = (await save([])).operation;
    expect(await runOp(clear.id)).toBe("applied");
    expect((await get()).menus).toEqual([]);
  });

  it("round trip keeps allergens, dietary tags, spiciness, options and every untouched field", async () => {
    const attributes = {
      price: { currencyCode: "USD", units: "9", nanos: 0 },
      spiciness: "HOT",
      allergen: ["PEANUT", "TREE_NUT"],
      dietaryRestriction: ["VEGAN", "GLUTEN_FREE"],
      nutritionFacts: { calories: { lowerAmount: 400, upperAmount: 500, unit: "CALORIE" }, protein: { lowerAmount: 12, unit: "GRAM" } },
      ingredients: [{ labels: label("Basil") }],
      servesNumPeople: 2,
      preparationMethods: ["BAKED"],
      portionSize: { quantity: 1, unit: label("slice") },
      mediaKeys: ["media/1"],
    };
    const rich = menu({
      sections: [{
        labels: label("Mains"),
        items: [{
          labels: label("Pizza"),
          attributes,
          options: [{ labels: label("Large"), attributes: { ...attributes, price: { currencyCode: "USD", units: "14", nanos: 0 } } }],
        }],
      }],
    });
    const op = (await save([rich])).operation;
    expect(await runOp(op.id)).toBe("applied");
    expect((await get()).menus).toEqual([rich]);
    const clear = (await save([])).operation;
    expect(await runOp(clear.id)).toBe("applied");
  });

  it("rejects values outside Google's enums and an option without a price", async () => {
    const withAttrs = (extra: Record<string, unknown>, options?: unknown) => [menu({
      sections: [{ labels: label("S"), items: [{
        labels: label("I"),
        attributes: { price: { currencyCode: "USD", units: "1" }, ...extra },
        ...(options ? { options } : {}),
      }] }],
    })];
    for (const menus of [
      withAttrs({ allergen: ["GLUTEN"] }),
      withAttrs({ dietaryRestriction: ["PALEO"] }),
      withAttrs({ spiciness: "EXTRA_HOT" }),
      withAttrs({}, [{ labels: label("Large"), attributes: {} }]),
      withAttrs({}, [{ labels: [], attributes: { price: { currencyCode: "USD", units: "1" } } }]),
    ]) expect(await codeOf(save(menus))).toBe("INVALID_INPUT");
  });

  it("a location that cannot have a food menu (Google 400/404) reads as supported:false, not an error; other errors still fail", async () => {
    for (const status of [400, 404]) {
      const spy = vi.spyOn(mock, "getFoodMenus").mockRejectedValueOnce(new GoogleApiError(status, {}));
      expect(await get()).toMatchObject({ supported: false, menus: [] });
      spy.mockRestore();
    }
    const spy = vi.spyOn(mock, "getFoodMenus").mockRejectedValueOnce(new GoogleApiError(403, {}));
    expect(await codeOf(get())).not.toBe("no error");
    spy.mockRestore();
    expect((await get()).supported).toBe(true);
    expect([400, 404, 403, 429, 500].map((n) => isFoodMenuUnsupported(new GoogleApiError(n, {})))).toEqual([true, true, false, false, false]);
    expect(isFoodMenuUnsupported(new Error("x"))).toBe(false);
  });

  it("rejects invalid menus before anything is queued", async () => {
    const bad = [
      [{ ...menu(), sections: [] }],
      [{ ...menu(), labels: [] }],
      [{ ...menu(), labels: label("x".repeat(141)) }],
      [{ ...menu(), sections: [{ labels: label("S"), items: [] }] }],
      [menu({ sections: [{ labels: label("S"), items: [{ labels: label("I"), attributes: {} }] }] })],
    ];
    for (const menus of bad) {
      expect(await codeOf(save(menus))).toBe("INVALID_INPUT");
    }
  });

  it("client roles read but cannot save; audit row carries counts, not the menu", async () => {
    expect(await codeOf(save([menu()], org.viewerA))).toBe("FORBIDDEN");
    await get(org.viewerA);
    const rows = await kit.auditRows(org.orgId, "food_menu.update_requested");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain("Margherita");
  });

  it("write gate: with Google writes off the op fails as google_writes_disabled and nothing is written", async () => {
    const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
    const op = (await save([menu()])).operation;
    const writes = mock.calls.filter((c) => c.method === "updateFoodMenus").length;
    expect(await processLocationOp(db, { opId: op.id }, { client: readOnly })).toBe("failed");
    expect((await db.select().from(locationWriteOps).where(eq(locationWriteOps.id, op.id)))[0]).toMatchObject({
      status: "failed",
      error: "google_writes_disabled",
    });
    expect(mock.calls.filter((c) => c.method === "updateFoodMenus").length).toBe(writes);
  });
});
