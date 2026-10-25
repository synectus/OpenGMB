import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql as sqlText } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  profileChangeSets,
  profileChanges,
  profileChangeTargets,
} from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { PROFILE_APPLY_QUEUE, processProfileApply } from "./profile/jobs";
import { PROFILE_SNAPSHOT_QUEUE, processProfileSnapshot } from "./profile/watch";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";

// L8: the nightly watch undoes outside edits to name / phone / address when a location switched it on.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const kit = makeKit(db, mock);
const { run } = kit;

type Change = {
  id: string;
  status: string;
  fieldPaths: string[];
  googleSuggested: boolean;
  resolvedBy: string | null;
  resolvedByName: string | null;
  revertChangeSetId: string | null;
  revertChangeSetStatus: string | null;
  revertChangeSetSurface: string | null;
};
const snap = (loc: Loc) => processProfileSnapshot(db, { locationId: loc.row.id }, { client });
const changes = (org: Org, loc: Loc) =>
  run<{ changes: Change[] }>(org.owner, "profile.changes.list", { locationId: loc.row.id }).then(
    (r) => r.changes,
  );
const googleTitle = async (loc: Loc) => (await mock.getLocation(loc.google)).title;
const setTitle = (loc: Loc, title: string) => mock.editLocation(loc.google, { title }, ["title"]);
const setDescription = (loc: Loc, description: string) =>
  mock.editLocation(loc.google, { profile: { description } }, ["profile"]);
/** The worker applies the queued revert: run its apply jobs by hand, as profileWatch.test does. */
const applyQueued = async (changeSetId: string) => {
  for (const t of await db
    .select()
    .from(profileChangeTargets)
    .where(eq(profileChangeTargets.changeSetId, changeSetId))) {
    if (t.status === "pending") await processProfileApply(db, { targetId: t.id }, { client });
  }
};
const enable = (org: Org, loc: Loc, flags: { name?: boolean; phone?: boolean; address?: boolean }) =>
  run(org.owner, "profile.autoRevert.set", { locationId: loc.row.id, ...flags });

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(PROFILE_APPLY_QUEUE);
  await boss.createQueue(PROFILE_SNAPSHOT_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("the setting", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("is off by default, saved by an owner or admin, and refused to a manager and a client", async () => {
    const get = () =>
      run(org.owner, "profile.autoRevert.get", { locationId: loc.row.id });
    expect(await get()).toMatchObject({ name: false, phone: false, address: false });
    expect(await enable(org, loc, { name: true, address: true })).toMatchObject({
      name: true,
      phone: false,
      address: true,
    });
    // A partial update changes only what it names.
    expect(await enable(org, loc, { name: false })).toMatchObject({ name: false, address: true });
    expect(await get()).toMatchObject({ name: false, phone: false, address: true });
    for (const actor of [org.manager, org.approverA, org.viewerA]) {
      expect(
        await codeOf(run(actor, "profile.autoRevert.set", { locationId: loc.row.id, name: true })),
      ).toBe("FORBIDDEN");
    }
    expect(await codeOf(run(org.approverB, "profile.autoRevert.get", { locationId: loc.row.id }))).toBe(
      "NOT_FOUND",
    );
    expect((await kit.auditRows(org.orgId, "location.auto_revert_set")).length).toBe(2);
  });
});

describe("the nightly watch with auto-revert", () => {
  let org: Org;
  beforeAll(async () => {
    org = await kit.makeOrg();
  });
  /** A location with its baseline snapshot taken. */
  const fresh = async (flags: { name?: boolean; phone?: boolean; address?: boolean } | null) => {
    const loc = await org.mkLoc(org.a);
    if (flags) await enable(org, loc, flags);
    expect(await snap(loc)).toBe("baseline");
    return loc;
  };

  it("switch off: the outside edit raises the alert and nothing is reverted", async () => {
    const loc = await fresh(null);
    setTitle(loc, "Renamed on Google");
    expect(await snap(loc)).toBe("changed");
    const [c] = await changes(org, loc);
    expect(c).toMatchObject({ status: "open", fieldPaths: ["title"], revertChangeSetId: null });
    expect(await googleTitle(loc)).toBe("Renamed on Google");
    expect(await kit.auditRows(org.orgId, "profile.change_auto_reverted")).toEqual([]);
  });

  it("switch on: the edit is reverted through the normal change set, approval and apply, and audited", async () => {
    const loc = await fresh({ name: true });
    const original = await googleTitle(loc);
    setTitle(loc, "Renamed on Google");
    expect(await snap(loc)).toBe("changed");
    const [c] = await changes(org, loc);
    expect(c).toMatchObject({
      status: "reverted",
      fieldPaths: ["title"],
      googleSuggested: false,
      revertChangeSetStatus: "queued",
      revertChangeSetSurface: "worker",
      resolvedBy: null,
      resolvedByName: null,
    });
    // Nothing reached Google until the apply job ran, and then only the old name was written back.
    expect(await googleTitle(loc)).toBe("Renamed on Google");
    await applyQueued(c!.revertChangeSetId!);
    expect(await googleTitle(loc)).toBe(original);
    const [cs] = await db
      .select()
      .from(profileChangeSets)
      .where(eq(profileChangeSets.id, c!.revertChangeSetId!));
    expect(cs).toMatchObject({ status: "applied", createdSurface: "worker" });

    const done = (await kit.auditRows(org.orgId, "profile.change_auto_reverted")).filter(
      (a) => a.entityId === c!.id,
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ surface: "worker", actorType: "system" });
    expect(done[0]!.after).toMatchObject({
      trigger: "auto_revert",
      fieldNames: ["title"],
      changeSetId: c!.revertChangeSetId,
    });
    const reverted = (await kit.auditRows(org.orgId, "profile.change_reverted")).filter(
      (a) => a.entityId === c!.id,
    );
    expect(reverted[0]!.after).toMatchObject({ trigger: "auto_revert" });
    // The values themselves never enter the audit log.
    expect(JSON.stringify(done[0]!.after)).not.toContain("Renamed on Google");

    // Our own write is not reported back as a new outside change.
    expect(await snap(loc)).toBe("own_changes_only");
    expect((await changes(org, loc)).filter((x) => x.status === "open")).toEqual([]);
  });

  it("reverts phone and address when those switches are on", async () => {
    const loc = await org.mkLoc(org.a);
    const home = { regionCode: "US", addressLines: ["2 Main Street"], locality: "Springfield" };
    mock.editLocation(loc.google, { storefrontAddress: home }, ["storefrontAddress"]);
    await enable(org, loc, { phone: true, address: true });
    expect(await snap(loc)).toBe("baseline");
    const before = await mock.getLocation(loc.google);
    mock.editLocation(
      loc.google,
      {
        phoneNumbers: { primaryPhone: "+1 555 000 1234" },
        storefrontAddress: { regionCode: "US", addressLines: ["1 Other Street"], locality: "Elsewhere" },
      },
      ["phoneNumbers", "storefrontAddress"],
    );
    expect(await snap(loc)).toBe("changed");
    const [c] = await changes(org, loc);
    expect(c).toMatchObject({
      status: "reverted",
      revertChangeSetSurface: "worker",
      revertChangeSetStatus: "queued",
    });
    expect([...c!.fieldPaths].sort()).toEqual(["phoneNumbers", "storefrontAddress"]);
    await applyQueued(c!.revertChangeSetId!);
    const targets = await db
      .select()
      .from(profileChangeTargets)
      .where(eq(profileChangeTargets.changeSetId, c!.revertChangeSetId!));
    expect(targets.map((t) => [t.status, t.error])).toEqual([["applied", null]]);
    const after = await mock.getLocation(loc.google);
    expect(after.phoneNumbers?.primaryPhone).toBe(before.phoneNumbers?.primaryPhone);
    expect(after.storefrontAddress).toMatchObject(home);
  });

  it("a restore that fails the guardrails stays a blocked change set for a person; nothing is written", async () => {
    // The location had no usable address (no country) before the outside edit: restoring it is blocked.
    const loc = await fresh({ address: true });
    mock.editLocation(
      loc.google,
      { storefrontAddress: { regionCode: "US", addressLines: ["1 Other Street"] } },
      ["storefrontAddress"],
    );
    expect(await snap(loc)).toBe("changed");
    const [c] = await changes(org, loc);
    expect(c).toMatchObject({ status: "reverted", revertChangeSetStatus: "blocked" });
    expect((await mock.getLocation(loc.google)).storefrontAddress?.addressLines).toEqual([
      "1 Other Street",
    ]);
    const skipped = (await kit.auditRows(org.orgId, "profile.auto_revert_skipped")).filter(
      (a) => a.entityId === c!.id,
    );
    expect(skipped[0]!.after).toMatchObject({ reason: "change_set_blocked" });
  });

  it("a field that is not switched on is not reverted, even in the same sweep", async () => {
    const loc = await fresh({ name: true });
    mock.editLocation(loc.google, { phoneNumbers: { primaryPhone: "+1 555 000 9999" } }, ["phoneNumbers"]);
    setDescription(loc, "Typed on Google");
    expect(await snap(loc)).toBe("changed");
    let list = await changes(org, loc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "open", revertChangeSetId: null });
    expect([...list[0]!.fieldPaths].sort()).toEqual(["description", "phoneNumbers"]);

    // Name plus description in one night: two alerts, only the name is undone.
    setTitle(loc, "Renamed on Google");
    setDescription(loc, "Typed on Google again");
    expect(await snap(loc)).toBe("changed");
    list = (await changes(org, loc)).filter((x) => x.id !== list[0]!.id);
    expect(list.map((x) => [x.fieldPaths.join(","), x.status]).sort()).toEqual([
      ["description", "open"],
      ["title", "reverted"],
    ]);
    const named = list.find((x) => x.fieldPaths[0] === "title")!;
    await applyQueued(named.revertChangeSetId!);
    expect(await googleTitle(loc)).not.toBe("Renamed on Google");
    expect((await mock.getLocation(loc.google)).profile?.description).toBe("Typed on Google again");
  });

  it("never reverts a value Google is suggesting, and only touches outside edits", async () => {
    const loc = await fresh({ name: true });
    await db.insert(profileChanges).values({
      orgId: org.orgId,
      locationId: loc.row.id,
      source: "push",
      fieldPaths: ["title"],
      before: { fields: { title: "Old" }, attributes: {} },
      after: { fields: { title: "Google's suggestion" }, attributes: {} },
      googleSuggested: true,
    });
    setTitle(loc, "Google's suggestion");
    expect(await snap(loc)).toBe("changed");
    const outside = (await changes(org, loc)).filter((x) => !x.googleSuggested);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ status: "open", revertChangeSetId: null });
    expect(await googleTitle(loc)).toBe("Google's suggestion");
    // The suggestion row itself stays open for a person; revert is refused for it by the action.
    const [g] = await db
      .select()
      .from(profileChanges)
      .where(and(eq(profileChanges.locationId, loc.row.id), eq(profileChanges.googleSuggested, true)));
    expect(g!.status).toBe("open");
  });

  it("reverts a field at most once in 24 hours", async () => {
    const loc = await fresh({ name: true });
    setTitle(loc, "Fight 1");
    await snap(loc);
    const [first] = await changes(org, loc);
    expect(first!.status).toBe("reverted");
    await applyQueued(first!.revertChangeSetId!);
    expect(await snap(loc)).toBe("own_changes_only");

    // Another tool changes it again within the day: only the alert is raised.
    setTitle(loc, "Fight 2");
    expect(await snap(loc)).toBe("changed");
    const second = (await changes(org, loc)).find((x) => x.id !== first!.id)!;
    expect(second).toMatchObject({ status: "open", revertChangeSetId: null });
    expect(await googleTitle(loc)).toBe("Fight 2");

    // A day later the same field may be undone again.
    await db
      .update(profileChangeSets)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(profileChangeSets.id, first!.revertChangeSetId!));
    setTitle(loc, "Fight 3");
    expect(await snap(loc)).toBe("changed");
    const third = (await changes(org, loc)).find((x) => x.id !== first!.id && x.id !== second.id)!;
    expect(third).toMatchObject({ status: "reverted", revertChangeSetSurface: "worker" });
  });

  it("does nothing for a suspended, unverified or unreadable location", async () => {
    for (const state of [
      { complyWithGuidelines: { recommendationReason: "BUSINESS_LOCATION_SUSPENDED" } },
      { verify: { hasPendingVerification: false } },
      { waitForVoiceOfMerchant: {} },
    ]) {
      const loc = await fresh({ name: true });
      mock.setVoiceOfMerchantState(loc.google, state);
      setTitle(loc, "Renamed on Google");
      expect(await snap(loc)).toBe("changed");
      const [c] = await changes(org, loc);
      expect(c).toMatchObject({ status: "open", revertChangeSetId: null });
    }
  });

  it("leaves the alert open and says why when the person who enabled it can no longer approve", async () => {
    const loc = await fresh({ name: true });
    // A client approver cannot edit profiles: their standing approval is not enough.
    await db.execute(
      sqlText`update location_auto_revert set enabled_by = ${org.approverA.userId} where location_id = ${loc.row.id}`,
    );
    setTitle(loc, "Renamed on Google");
    await snap(loc);
    const [c] = await changes(org, loc);
    expect(c).toMatchObject({ status: "open", revertChangeSetId: null });
    const skipped = (await kit.auditRows(org.orgId, "profile.auto_revert_skipped")).filter(
      (a) => a.entityId === c!.id,
    );
    expect(skipped[0]!.after).toMatchObject({ reason: "enabler_cannot_approve" });
  });
});
