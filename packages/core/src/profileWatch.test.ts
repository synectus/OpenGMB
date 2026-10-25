import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDb,
  locations,
  notifications,
  profileChanges,
  profileChangeTargets,
  profileSnapshots,
  users,
} from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { PROFILE_APPLY_QUEUE, processProfileApply } from "./profile/jobs";
import {
  PROFILE_SNAPSHOT_QUEUE,
  detectGoogleSuggestion,
  enqueueNightlyProfileSnapshots,
  processProfileSnapshot,
  recordGoogleSuggestion,
} from "./profile/watch";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";

// The shared test database is also used by every other suite, often at the same time.
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
  revertChangeSetId: string | null;
  revertChangeSetStatus: string | null;
  resolvedByName: string | null;
  revertChangeSetSurface: string | null;
  before: { fields: Record<string, unknown>; attributes: Record<string, unknown> };
  after: { fields: Record<string, unknown>; attributes: Record<string, unknown> };
  can: { accept: boolean; revert: boolean; dismiss: boolean };
};
const list = (org: Org, actor: Org["owner"], input: object = {}) =>
  run<{ changes: Change[] }>(actor, "profile.changes.list", input).then((r) => r.changes);
const snap = (loc: Loc) => processProfileSnapshot(db, { locationId: loc.row.id }, { client });
const snapshots = (loc: Loc) =>
  db.select().from(profileSnapshots).where(eq(profileSnapshots.locationId, loc.row.id));
const notes = (loc: Loc) =>
  db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.sourceType, "profile_change"), eq(notifications.orgId, loc.row.orgId)),
    );
const edit = (loc: Loc, description: string) =>
  mock.editLocation(loc.google, { profile: { description } }, ["profile"]);
const tick = () => new Promise((r) => setTimeout(r, 15));

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

describe("nightly snapshots and the field diff", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("the first snapshot is a baseline (no change); an unchanged profile stores nothing", async () => {
    expect(await snap(loc)).toBe("baseline");
    expect(await snapshots(loc)).toHaveLength(1);
    expect(await snap(loc)).toBe("unchanged");
    expect(await snap(loc)).toBe("unchanged");
    expect(await snapshots(loc)).toHaveLength(1);
    expect(await list(org, org.owner, { locationId: loc.row.id })).toEqual([]);
  });

  it("an outside edit stores a snapshot only when the hash changed and records the field diff", async () => {
    edit(loc, "Edited in the Google UI.");
    mock.editAttribute(loc.google, {
      name: "attributes/has_parking",
      valueType: "BOOL",
      values: [true],
    });
    expect(await snap(loc)).toBe("changed");
    expect(await snapshots(loc)).toHaveLength(2);
    const [c] = await list(org, org.owner, { locationId: loc.row.id });
    expect(c).toMatchObject({ status: "open", googleSuggested: false });
    expect(c!.fieldPaths).toEqual(["description", "attributes/has_parking"]);
    expect(c!.before.fields.description).toBeNull();
    expect(c!.after.fields.description).toBe("Edited in the Google UI.");
    expect(c!.after.attributes["attributes/has_parking"]).toEqual({ values: [true] });
    // Same state again: no new snapshot, no new change.
    expect(await snap(loc)).toBe("unchanged");
    expect(await snapshots(loc)).toHaveLength(2);
    expect(await list(org, org.owner, { locationId: loc.row.id })).toHaveLength(1);
  });

  it("alerts with profile.changed: location name in the title, field names (not values) in the audit row", async () => {
    const n = (await notes(loc)).filter((x) => x.userId === org.owner.userId);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      kind: "profile.changed",
      title: `Profile change at ${loc.row.name}`,
      link: `/locations/${loc.row.id}/changes`,
    });
    const audits = await kit.auditRows(org.orgId, "profile.change_detected");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.surface).toBe("worker");
    expect(JSON.stringify(audits[0]!.after)).toContain("description");
    expect(JSON.stringify([n, audits.map((a) => a.after)])).not.toContain(
      "Edited in the Google UI",
    );
  });

  it("skips inactive and unlinked locations", async () => {
    const off = await org.mkLoc(org.a, { status: "inactive" });
    expect(await snap(off)).toBe("skipped");
    const unlinked = await org.mkLoc(org.a, { googleLocationId: null });
    expect(await snap(unlinked)).toBe("skipped");
  });

  it("the nightly fan-out queues one job per active linked location", async () => {
    const mine = await org.mkLoc(org.a);
    const r = await enqueueNightlyProfileSnapshots(db, { orgId: org.orgId });
    // this org's active linked locations: the ones made above that are active and linked
    expect(r.enqueued).toBe(
      (await db.select().from(locations).where(eq(locations.orgId, org.orgId))).filter(
        (l) => l.status === "active" && l.googleLocationId && l.connectionId,
      ).length,
    );
    const jobs = await sql<{ n: string }[]>`
      select count(*)::text as n from pgboss.job where name = ${PROFILE_SNAPSHOT_QUEUE} and data->>'locationId' = ${mine.row.id}`;
    expect(Number(jobs[0]!.n)).toBe(1);
  });
});

describe("accept, dismiss and permissions", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
    await snap(loc);
  });
  const newChange = async (text: string) => {
    edit(loc, text);
    await snap(loc);
    return (await list(org, org.owner, { locationId: loc.row.id, status: "open" }))[0]!;
  };

  it("accept and dismiss resolve an open change once, with audit rows and no Google call", async () => {
    const before = mock.callCount;
    const c1 = await newChange("First outside edit.");
    const acc = await run<{ change: Change }>(org.manager, "profile.changes.accept", { id: c1.id });
    expect(acc.change.status).toBe("accepted");
    expect(await codeOf(run(org.manager, "profile.changes.accept", { id: c1.id }))).toBe(
      "CONFLICT",
    );
    const c2 = await newChange("Second outside edit.");
    const dis = await run<{ change: Change }>(org.manager, "profile.changes.dismiss", {
      id: c2.id,
    });
    expect(dis.change.status).toBe("dismissed");
    expect(mock.calls.slice(before).filter((c) => /update|create|delete/i.test(c.method))).toEqual(
      [],
    );
    for (const action of ["profile.change_accepted", "profile.change_dismissed"]) {
      const rows = await kit.auditRows(org.orgId, action);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.after)).not.toContain("outside edit");
    }
    expect((await list(org, org.owner, { status: "accepted" })).map((c) => c.id)).toEqual([c1.id]);
  });

  it("client roles can read the list but are FORBIDDEN to accept, dismiss or revert", async () => {
    const c = await newChange("Third outside edit.");
    expect((await list(org, org.viewerA, { locationId: loc.row.id })).length).toBeGreaterThan(0);
    expect((await list(org, org.viewerA, { status: "open" }))[0]!.can).toEqual({
      accept: false,
      revert: false,
      dismiss: false,
    });
    for (const actor of [org.viewerA, org.approverA]) {
      for (const a of ["accept", "dismiss", "revert"]) {
        expect(await codeOf(run(actor, `profile.changes.${a}`, { id: c.id }))).toBe("FORBIDDEN");
      }
    }
    // A client of another workspace cannot even see it.
    expect(await list(org, org.approverB, { locationId: loc.row.id })).toEqual([]);
    expect(
      await codeOf(run(org.manager, "profile.changes.accept", { id: crypto.randomUUID() })),
    ).toBe("NOT_FOUND");
  });
});

describe("revert goes through a change set, approval and the guarded apply", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
    await snap(loc);
  });
  const outside = async (text: string) => {
    edit(loc, text);
    await snap(loc);
    return (await list(org, org.owner, { locationId: loc.row.id, status: "open" }))[0]!;
  };
  const csOf = (id: string) =>
    run<{
      changeSet: {
        id: string;
        status: string;
        targets: { status: string; error: string | null }[];
      };
    }>(org.owner, "profile.changeSets.get", { id }).then((r) => r.changeSet);
  const applyAll = async (id: string) => {
    await run(org.manager, "profile.apply", { id });
    for (const t of await db
      .select()
      .from(profileChangeTargets)
      .where(eq(profileChangeTargets.changeSetId, id))) {
      if (t.status === "pending") await processProfileApply(db, { targetId: t.id }, { client });
    }
  };

  it("creates a pending_approval change set that restores the old values; nothing is written until applied", async () => {
    const c = await outside("A description someone typed on Google.");
    const writes = mock.calls.length;
    const r = await run<{ change: Change; changeSetId: string; changeSetStatus: string }>(
      org.manager,
      "profile.changes.revert",
      { id: c.id },
    );
    expect(mock.calls.length).toBe(writes); // the action never calls Google
    expect(r.changeSetStatus).toBe("pending_approval");
    expect(r.change).toMatchObject({ status: "reverted", revertChangeSetId: r.changeSetId });
    const cs = await csOf(r.changeSetId);
    expect(cs.targets).toHaveLength(1);
    const [t] = await db
      .select()
      .from(profileChangeTargets)
      .where(eq(profileChangeTargets.changeSetId, r.changeSetId));
    expect((t!.before as { fields: Record<string, unknown> }).fields.description).toBe(
      "A description someone typed on Google.",
    );
    expect((t!.after as { fields: Record<string, unknown> }).fields.description).toBeNull();
    expect((await mock.getLocation(loc.google)).profile?.description).toBe(
      "A description someone typed on Google.",
    );
    // A second revert of the same change is refused while its change set is alive.
    expect(await codeOf(run(org.manager, "profile.changes.revert", { id: c.id }))).toBe("CONFLICT");

    await run(org.approverA, "profile.approve", { id: r.changeSetId });
    await tick();
    await applyAll(r.changeSetId);
    expect((await csOf(r.changeSetId)).status).toBe("applied");
    expect((await mock.getLocation(loc.google)).profile?.description).toBeUndefined();
    const writesDone = mock.calls.filter(
      (x) => x.method === "updateLocation" && x.args[0] === loc.google,
    );
    expect(writesDone).toHaveLength(1);
    expect(writesDone[0]!.args[2]).toEqual(["profile"]);

    // Our own revert is not reported as a new outside change by the next snapshot.
    expect(await snap(loc)).toBe("own_changes_only");
    expect(await list(org, org.owner, { locationId: loc.row.id, status: "open" })).toEqual([]);
  });

  it("inherits conflict handling: if Google changed again since detection, nothing is written", async () => {
    const c = await outside("Typed on Google (version 1).");
    const r = await run<{ changeSetId: string }>(org.manager, "profile.changes.revert", {
      id: c.id,
    });
    await run(org.approverA, "profile.approve", { id: r.changeSetId });
    edit(loc, "Typed on Google again (version 2).");
    const writes = mock.calls.filter((x) => x.method === "updateLocation").length;
    await applyAll(r.changeSetId);
    const cs = await csOf(r.changeSetId);
    expect(cs.status).toBe("failed");
    expect(cs.targets[0]).toMatchObject({ status: "failed", error: "conflict" });
    expect(mock.calls.filter((x) => x.method === "updateLocation").length).toBe(writes);
    expect((await mock.getLocation(loc.google)).profile?.description).toBe(
      "Typed on Google again (version 2).",
    );
  });

  it("a reverted change whose change set was cancelled can be reverted again", async () => {
    const c = await outside("Typed on Google (version 3).");
    const r1 = await run<{ changeSetId: string }>(org.manager, "profile.changes.revert", {
      id: c.id,
    });
    await run(org.manager, "profile.cancel", { id: r1.changeSetId });
    const [row] = await list(org, org.owner, { status: "reverted" }).then((l) =>
      l.filter((x) => x.id === c.id),
    );
    expect(row).toMatchObject({ revertChangeSetStatus: "cancelled", can: { revert: true } });
    const r2 = await run<{ changeSetId: string; change: Change }>(
      org.manager,
      "profile.changes.revert",
      { id: c.id },
    );
    expect(r2.changeSetId).not.toBe(r1.changeSetId);
    expect(r2.change.revertChangeSetId).toBe(r2.changeSetId);
  });

  it("a restored value that fails the guardrails comes back as a blocked change set, not an error", async () => {
    const c = await outside("x".repeat(40));
    edit(loc, "Short."); // a later outside edit; revert restores "before"
    await snap(loc);
    // before = the value ahead of the first edit above; craft a change whose "before" is too long
    const [row] = await db.select().from(profileChanges).where(eq(profileChanges.id, c.id));
    await db
      .update(profileChanges)
      .set({ before: { fields: { description: "y".repeat(800) }, attributes: {} } })
      .where(eq(profileChanges.id, row!.id));
    const r = await run<{ changeSetStatus: string }>(org.manager, "profile.changes.revert", {
      id: c.id,
    });
    expect(r.changeSetStatus).toBe("blocked");
  });
});

describe("GOOGLE_UPDATE suggestions", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("getGoogleUpdated returns Google's view and a diffMask; patching the path clears it", async () => {
    expect(
      (await mock.getGoogleUpdated(loc.google, { readMask: "name,title" })).diffMask,
    ).toBeUndefined();
    mock.suggestGoogleChange(loc.google, { websiteUri: "https://google-says.example.test" }, [
      "websiteUri",
    ]);
    const g = await mock.getGoogleUpdated(loc.google, { readMask: "name,websiteUri" });
    expect(g).toMatchObject({
      diffMask: "websiteUri",
      location: { websiteUri: "https://google-says.example.test" },
    });
    expect((await mock.getLocation(loc.google)).websiteUri).toBe("https://example.test/start");
  });

  it("detects the suggestion (merchant before, Google after), stores it once, never as a snapshot", async () => {
    const found = await detectGoogleSuggestion(client, loc.google);
    expect(found).toMatchObject({
      fieldPaths: ["websiteUri"],
      before: { fields: { websiteUri: "https://example.test/start" } },
      after: { fields: { websiteUri: "https://google-says.example.test" } },
    });
    const c = await db.transaction((tx) => recordGoogleSuggestion(tx, loc.row, found!));
    expect(c).not.toBeNull();
    // the same suggestion pushed again while one is open stores nothing new
    expect(await db.transaction((tx) => recordGoogleSuggestion(tx, loc.row, found!))).toBeNull();
    const [row] = await list(org, org.owner, { locationId: loc.row.id });
    expect(row).toMatchObject({
      googleSuggested: true,
      status: "open",
      fieldPaths: ["websiteUri"],
    });
    // the snapshot stays the merchant view: the first one is a baseline and the suggestion is not in it
    expect(await snap(loc)).toBe("baseline");
    const [s] = await snapshots(loc);
    expect((s!.data as { fields: { websiteUri: string } }).fields.websiteUri).toBe(
      "https://example.test/start",
    );
    expect(await snap(loc)).toBe("unchanged");
    expect(await list(org, org.owner, { locationId: loc.row.id })).toHaveLength(1);
  });

  it("accept keeps Google's value (no write); revert is refused for a suggestion", async () => {
    const [c] = await list(org, org.owner, { locationId: loc.row.id });
    expect(c!.can).toEqual({ accept: true, revert: false, dismiss: true });
    expect(await codeOf(run(org.manager, "profile.changes.revert", { id: c!.id }))).toBe(
      "INVALID_INPUT",
    );
    const writes = mock.calls.filter((x) => x.method === "updateLocation").length;
    const r = await run<{ change: Change }>(org.manager, "profile.changes.accept", { id: c!.id });
    expect(r.change.status).toBe("accepted");
    expect(mock.calls.filter((x) => x.method === "updateLocation").length).toBe(writes);
  });

  it("a diffMask entry outside the editable fields is recorded by name only", async () => {
    const other = await org.mkLoc(org.a);
    mock.suggestGoogleChange(other.google, { labels: ["vip"] } as never, ["labels"]);
    const found = await detectGoogleSuggestion(client, other.google);
    expect(found).toMatchObject({ fieldPaths: ["labels"] });
    expect(found!.before.fields).toEqual({});
  });

  it("an address suggestion carries both values (the address is an editable field since L5)", async () => {
    const other = await org.mkLoc(org.a);
    mock.suggestGoogleChange(
      other.google,
      { storefrontAddress: { regionCode: "US", locality: "Elsewhere" } },
      ["storefrontAddress"],
    );
    const found = await detectGoogleSuggestion(client, other.google);
    expect(found).toMatchObject({ fieldPaths: ["storefrontAddress"] });
    expect(found!.after.fields.storefrontAddress).toEqual({ regionCode: "US", locality: "Elsewhere" });
  });

  it("a snapshot stored before storeCode and the address joined the profile reports no phantom change", async () => {
    const own = await org.mkLoc(org.a);
    await mock.updateLocation(own.google, { storeCode: "OLD-1" }, ["storeCode"]);
    expect(await snap(own)).toBe("baseline");
    // Rewrite the stored snapshot the way an older build stored it: without the two fields.
    const [s] = await snapshots(own);
    const data = s!.data as { fields: Record<string, unknown> };
    delete data.fields.storeCode;
    delete data.fields.storefrontAddress;
    await db.update(profileSnapshots).set({ data, hash: "stale" }).where(eq(profileSnapshots.id, s!.id));
    // The hash differs, so a diff runs; storeCode and the address are not reported as outside edits.
    expect(await snap(own)).toBe("own_changes_only");
  });
});

describe("who resolved a change and who drafted its revert", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
    await snap(loc);
    await db.update(users).set({ name: "Priya" }).where(eq(users.id, org.manager.userId));
  });
  const outside = async (text: string) => {
    edit(loc, text);
    await snap(loc);
    return (await list(org, org.owner, { locationId: loc.row.id, status: "open" }))[0]!;
  };

  it("an open change has no names; accepting names the person in the output and in the list", async () => {
    const c = await outside("Names edit one.");
    expect(c).toMatchObject({ resolvedByName: null, revertChangeSetSurface: null });
    const r = await run<{ change: Change }>(org.manager, "profile.changes.accept", { id: c.id });
    expect(r.change.resolvedByName).toBe("Priya");
    const [listed] = await list(org, org.owner, { locationId: loc.row.id, status: "accepted" });
    expect(listed).toMatchObject({ id: c.id, resolvedByName: "Priya" });
  });

  it("canary: a revert drafted in the app says ui, one drafted over MCP says mcp", async () => {
    const viaApp = await outside("Names edit two.");
    const a = await run<{ change: Change }>(org.manager, "profile.changes.revert", { id: viaApp.id });
    expect(a.change).toMatchObject({ resolvedByName: "Priya", revertChangeSetSurface: "ui" });

    const viaAgent = await outside("Names edit three.");
    const agent = { ...org.manager, surface: "mcp" as const, actorType: "api_token" as const };
    const b = await run<{ change: Change }>(agent, "profile.changes.revert", { id: viaAgent.id });
    expect(b.change.revertChangeSetSurface).toBe("mcp");

    const reverted = await list(org, org.owner, { locationId: loc.row.id, status: "reverted" });
    expect(Object.fromEntries(reverted.map((c) => [c.id, c.revertChangeSetSurface]))).toEqual({
      [viaApp.id]: "ui",
      [viaAgent.id]: "mcp",
    });
  });
});
