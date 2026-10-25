import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, profileChanges } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

type Listed = { changes: { id: string; locationId: string }[]; total: number };
const empty = { fields: {}, attributes: {} };

let org: Org;
let main: Loc;
let north: Loc;
let other: Loc;
const ids: Record<string, string> = {};
async function mk(name: string, loc: Loc, fieldPaths: string[], googleSuggested = false, status: "open" | "accepted" = "open") {
  const [r] = await db
    .insert(profileChanges)
    .values({ orgId: loc.row.orgId, locationId: loc.row.id, source: googleSuggested ? "push" : "nightly", fieldPaths, before: empty, after: empty, googleSuggested, status })
    .returning();
  ids[name] = r!.id;
}
const list = (input: object, actor = org.owner) => run<Listed>(actor, "profile.changes.list", input);
const names = (l: Listed) => Object.entries(ids).filter(([, id]) => l.changes.some((c) => c.id === id)).map(([n]) => n).sort();

beforeAll(async () => {
  org = await kit.makeOrg();
  main = await org.mkLoc(org.a);
  north = await org.mkLoc(org.a);
  other = await org.mkLoc(org.b);
  await mk("hoursMain", main, ["regularHours", "websiteUri"]);
  await mk("titleGoogle", main, ["title"], true);
  await mk("phoneNorth", north, ["phoneNumbers"]);
  await mk("specialNorthDone", north, ["specialHours"], false, "accepted");
  await mk("catsOther", other, ["categories", "attributes/has_wifi"]);
  const g = await run<{ group: { id: string } }>(org.owner, "locationGroups.create", { workspaceId: org.a, name: "Downtown" });
  await run(org.owner, "locationGroups.setMembers", { groupId: g.group.id, locationIds: [main.row.id] });
  ids.__group = g.group.id; // not a change; filtered out by names()
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("profile.changes.list across the org", () => {
  it("without a location it is org-wide in scope, newest first, with a total", async () => {
    const all = await list({});
    expect(names(all)).toEqual(["catsOther", "hoursMain", "phoneNorth", "specialNorthDone", "titleGoogle"]);
    expect(all.total).toBe(5);
  });
  it("canary: each filter narrows, and total counts past the limit", async () => {
    expect(names(await list({ googleSuggested: true }))).toEqual(["titleGoogle"]);
    expect(names(await list({ googleSuggested: false, status: "open" }))).toEqual(["catsOther", "hoursMain", "phoneNorth"]);
    expect(names(await list({ fields: ["regularHours", "specialHours"] }))).toEqual(["hoursMain", "specialNorthDone"]);
    expect(names(await list({ fields: ["categories"] }))).toEqual(["catsOther"]);
    expect(names(await list({ groupId: ids.__group }))).toEqual(["hoursMain", "titleGoogle"]);
    const capped = await list({ status: "open", limit: 1 });
    expect(capped.changes).toHaveLength(1);
    expect(capped.total).toBe(4);
  });
  it("scope still applies: a client of workspace B sees only B", async () => {
    expect(names(await list({}, org.approverB))).toEqual(["catsOther"]);
    expect((await list({}, org.approverB)).total).toBe(1);
  });
  it("rejects a field name that is not a profile field", async () => {
    await expect(list({ fields: ["address"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
