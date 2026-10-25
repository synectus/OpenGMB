import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  organizations,
  profileChangeSets,
  profileChangeTargets,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { GoogleApiError } from "./google/errors";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { assertPassed, guardrailSubject } from "./guardrails";
import { PROFILE_APPLY_QUEUE, processProfileApply } from "./profile/jobs";
import { PROFILE_LIMITS } from "./config/profile-limits";
import { PROFILE_GET_READ_MASK, profileDisplay } from "./profile/fetch";
import { profileGuardrailContext, checkProfile } from "./profile/guardrails";
import { publishProfileFields } from "./profile/publish";
import { computeDiff, desiredValues, mergeCategories, planServiceAdds, snapshotFromGoogle } from "./profile/fields";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Digits only, for Google ids (`locations/7<digits>`): the timestamp plus 9 random digits, so two files
// minting an id in the same millisecond cannot collide (stripping letters from uniq() could).
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
const mock = new MockGoogleClient();
const created: string[] = [];
const client = new ThrottledGoogleClient(mock, db);
const writes = (method: string, name?: string) =>
  mock.calls.filter((c) => c.method === method && (!name || c.args[0] === name));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}
const run = <T = never>(actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input) as Promise<T>;

type Change = { field: string; before: unknown; after: unknown };
type PreviewLoc = {
  locationId: string;
  error: string | null;
  current: unknown;
  changes: Change[];
  updateMask: string[];
  attributeMask: string[];
  noChange: boolean;
  guardrail: { ok: boolean; violations: { ruleId: string; severity: string; message: string }[] } | null;
};
type Target = {
  id: string;
  locationId: string;
  status: string;
  error: string | null;
  updateMask: string[];
  attributeMask: string[];
};
type ChangeSet = {
  id: string;
  status: string;
  updateMask: string[];
  targets: Target[];
  can: Record<string, boolean>;
  guardrail: { ok: boolean; violations: { ruleId: string }[] } | null;
};

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const mkUser = async (
    role: "owner" | "manager" | "client_approver" | "client_viewer",
    workspaceId?: string,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email: `${id}@example.test` };
  };
  const owner = await mkUser("owner");
  const actor = (u: { id: string }) =>
    loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  /** A location row plus a matching location in the mock Google. */
  const mkLoc = async (workspaceId: string, extra: Partial<typeof locations.$inferInsert> = {}) => {
    const n = uniqDigits().slice(-12);
    const name = `locations/7${n}`;
    mock.addLocation({ name, title: `Clinic ${n}` });
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name: `Clinic ${n}`,
        googleAccountName: "accounts/100000000000000000001",
        googleLocationId: name,
        connectionId,
        phone: "+1 555 010 0199",
        ...extra,
      })
      .returning();
    created.push(l!.id);
    return { row: l!, google: name };
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    manager: await actor(await mkUser("manager")),
    approverA: await actor(await mkUser("client_approver", a!.id)),
    approverB: await actor(await mkUser("client_approver", b!.id)),
    viewerA: await actor(await mkUser("client_viewer", a!.id)),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;
type Loc = Awaited<ReturnType<Org["mkLoc"]>>;

const preview = (org: Org, locs: Loc[], fields: unknown) =>
  run<{ locations: PreviewLoc[] }>(org.manager, "profile.preview", {
    locationIds: locs.map((l) => l.row.id),
    fields,
  });

/** Propose through the real preview -> propose path. */
async function propose(org: Org, locs: Loc[], fields: unknown, workspaceId = org.a) {
  const p = await preview(org, locs, fields);
  return run<{ changeSet: ChangeSet; result: { ok: boolean } }>(org.manager, "profile.propose", {
    workspaceId,
    locationIds: locs.map((l) => l.row.id),
    fields,
    snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
  });
}
async function approved(org: Org, locs: Loc[], fields: unknown) {
  const { changeSet } = await propose(org, locs, fields);
  expect(changeSet.status).toBe("pending_approval");
  await run(org.approverA, "profile.approve", { id: changeSet.id });
  return changeSet.id;
}
const getCs = async (org: Org, id: string) =>
  (await run<{ changeSet: ChangeSet }>(org.owner, "profile.changeSets.get", { id })).changeSet;
const targetsOf = (id: string) =>
  db.select().from(profileChangeTargets).where(eq(profileChangeTargets.changeSetId, id));
const jobsFor = async (targetId: string) =>
  (
    await sql<{ id: string }[]>`
      select id from pgboss.job where name = ${PROFILE_APPLY_QUEUE} and data->>'targetId' = ${targetId}`
  ).length;

/** Apply: the action queues, then run each target's job like the worker would. */
async function applyAll(org: Org, id: string, c: ThrottledGoogleClient = client) {
  const out = await run<{ jobsQueued: number }>(org.manager, "profile.apply", { id });
  const results: string[] = [];
  for (const t of await targetsOf(id)) {
    if (t.status === "pending")
      results.push(await processProfileApply(db, { targetId: t.id }, { client: c }));
  }
  return { ...out, results };
}

const hours = (closeHour: number) => ({
  periods: ["MONDAY", "TUESDAY"].map((d) => ({
    openDay: d,
    openTime: { hours: 9 },
    closeDay: d,
    closeTime: { hours: d === "TUESDAY" ? closeHour : 17 },
  })),
});

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(PROFILE_APPLY_QUEUE);
});
afterAll(async () => {
  // Other suites fan out over every active location in the shared test DB (nightly snapshots), so
  // leave none of ours active.
  await db.update(locations).set({ status: "inactive" }).where(inArray(locations.id, created));
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("profile.get and profile.preview (live from the mock, outside any transaction)", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("profile.get returns the normalised profile and the attributes with their types", async () => {
    const r = await run<{
      profile: { fields: Record<string, unknown>; attributes: Record<string, unknown> };
      attributes: { name: string; valueType: string | null }[];
    }>(org.manager, "profile.get", { locationId: loc.row.id });
    expect(r.profile.fields.title).toBe(loc.row.name);
    expect(r.profile.fields.websiteUri).toBe("https://example.test/start");
    expect(r.profile.fields.description).toBeNull();
    expect(r.attributes.map((a) => [a.name, a.valueType])).toEqual([
      ["attributes/has_wifi", "BOOL"],
      ["attributes/url_appointment", "URL"],
    ]);
  });

  it("profile.get adds display facts from its own read; preview keeps the shared mask", async () => {
    const own = await org.mkLoc(org.a);
    await mock.updateLocation(
      own.google,
      {
        storeCode: "LPC-001",
        storefrontAddress: {
          regionCode: "US",
          postalCode: "75940",
          administrativeArea: "TX",
          locality: "Rivermoor",
          addressLines: ["100 Main St", "Suite 4"],
        },
        categories: {
          primaryCategory: {
            name: "categories/gcid:pain_control_clinic",
            displayName: "Pain control clinic",
          },
          additionalCategories: [
            { name: "categories/gcid:medical_clinic", displayName: "Medical clinic" },
          ],
        },
      },
      ["storeCode", "storefrontAddress", "categories"],
    );
    const masks = (from: number) =>
      mock.calls
        .slice(from)
        .filter((c) => c.method === "getLocation")
        .map((c) => (c.args[1] as { readMask?: string } | undefined)?.readMask);

    const before = mock.calls.length;
    const r = await run<{
      display: {
        categoryNames: Record<string, string>;
        regionCode: string;
        languageCode: string;
      };
      profile: { fields: Record<string, unknown> };
    }>(org.manager, "profile.get", { locationId: own.row.id });
    expect(r.display).toEqual({
      categoryNames: {
        "categories/gcid:pain_control_clinic": "Pain control clinic",
        "categories/gcid:medical_clinic": "Medical clinic",
      },
      regionCode: "US",
      languageCode: "en",
    });
    // The snapshot (what diffs compare) still carries ids only.
    expect(r.profile.fields.categories).toEqual({
      primaryCategory: { name: "categories/gcid:pain_control_clinic" },
      additionalCategories: [{ name: "categories/gcid:medical_clinic" }],
    });
    expect(masks(before)).toEqual([PROFILE_GET_READ_MASK]);

    const mid = mock.calls.length;
    await preview(org, [own], { description: "Pain care in Rivermoor." });
    expect(masks(mid)).toEqual([PROFILE_LIMITS.readMask]);
  });

  it("profileDisplay: categories without display names", () => {
    expect(
      profileDisplay({
        name: "locations/1",
        title: "T",
        categories: { primaryCategory: { name: "categories/gcid:dentist" } },
      }),
    ).toEqual({
      categoryNames: {},
      regionCode: "US",
      languageCode: "en",
    });
  });

  it("a price-only change to a service item is a serviceItems change", async () => {
    const own = await org.mkLoc(org.a);
    const item = (units: string) => ({
      freeFormServiceItem: { category: "categories/gcid:dentist", label: { displayName: "Whitening" } },
      price: { currencyCode: "USD", units },
    });
    await mock.updateLocation(own.google, { serviceItems: [item("100")] }, ["serviceItems"]);
    const same = (await preview(org, [own], { serviceItems: [item("100")] })).locations[0]!;
    expect(same.noChange).toBe(true);
    const r = (await preview(org, [own], { serviceItems: [item("120")] })).locations[0]!;
    expect(r.updateMask).toEqual(["serviceItems"]);
    expect(r.changes.map((c) => c.field)).toEqual(["serviceItems"]);
  });

  it("the updateMask holds only the changed fields; an unchanged value is left out", async () => {
    const r = (
      await preview(org, [loc], {
        title: loc.row.name, // unchanged
        websiteUri: "https://example.test/start", // unchanged
        description: "Family dentistry in Riverside.",
        openingDate: { year: 2015, month: 3, day: 1 },
      })
    ).locations[0]!;
    expect(r.updateMask).toEqual(["profile", "openInfo.openingDate"]);
    expect(r.changes.map((c) => c.field)).toEqual(["description", "openingDate"]);
    expect(r.noChange).toBe(false);
    expect(r.guardrail).toMatchObject({ ok: true });
  });

  it("diffs nested hours, ignoring period order and zero-value spelling", async () => {
    const same = {
      periods: ["FRIDAY", "THURSDAY", "WEDNESDAY", "TUESDAY", "MONDAY"].map((d) => ({
        openDay: d,
        openTime: { hours: 9, minutes: 0 },
        closeDay: d,
        closeTime: { hours: 17 },
      })),
    };
    expect((await preview(org, [loc], { regularHours: same })).locations[0]!.noChange).toBe(true);
    const changed = {
      periods: same.periods.map((p) =>
        p.openDay === "TUESDAY" ? { ...p, closeTime: { hours: 18, minutes: 30 } } : p,
      ),
    };
    const r = (await preview(org, [loc], { regularHours: changed })).locations[0]!;
    expect(r.updateMask).toEqual(["regularHours"]);
    const c = r.changes[0]!;
    const tue = (v: unknown) =>
      (v as { periods: { openDay: string; closeTime: unknown }[] }).periods.find(
        (p) => p.openDay === "TUESDAY",
      )!.closeTime;
    expect(tue(c.before)).toEqual({ hours: 17, minutes: 0 });
    expect(tue(c.after)).toEqual({ hours: 18, minutes: 30 });
  });

  it("attributes: set, delete and unchanged", async () => {
    const r = (
      await preview(org, [loc], {
        attributes: {
          "attributes/has_wifi": { values: [true] }, // unchanged
          "attributes/has_parking": { values: [true] },
          "attributes/url_appointment": null,
        },
      })
    ).locations[0]!;
    expect(r.attributeMask).toEqual(["attributes/has_parking", "attributes/url_appointment"]);
    expect(r.updateMask).toEqual([]);
  });

  it("guardrails show up in the preview", async () => {
    const r = (await preview(org, [loc], { description: "x".repeat(751) })).locations[0]!;
    expect(r.guardrail?.ok).toBe(false);
    expect(r.guardrail?.violations.map((v) => v.ruleId)).toEqual(["PR.description-length"]);
    expect(await codeOf(preview(org, [loc], {}))).toBe("INVALID_INPUT");
  });
});

describe("propose: guardrails and the change set", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const ids = (cs: ChangeSet) => [...new Set(cs.guardrail!.violations.map((v) => v.ruleId))];

  it.each([
    ["too long a description", { description: "y".repeat(800) }, ["PR.description-length"]],
    ["a link in the description", { description: "See https://example.test now" }, ["U7.url"]],
    [
      "overlapping hours",
      {
        regularHours: {
          periods: [
            {
              openDay: "MONDAY",
              openTime: { hours: 9 },
              closeDay: "MONDAY",
              closeTime: { hours: 17 },
            },
            {
              openDay: "MONDAY",
              openTime: { hours: 16 },
              closeDay: "MONDAY",
              closeTime: { hours: 20 },
            },
          ],
        },
      },
      ["PR.hours-valid"],
    ],
    [
      "special hours with a bad date",
      {
        specialHours: {
          specialHourPeriods: [{ startDate: { year: 2026, month: 2, day: 30 }, closed: true }],
        },
      },
      ["PR.special-hours-valid"],
    ],
    ["a bad phone", { phoneNumbers: { primaryPhone: "call me" } }, ["PR.phone-format"]],
  ])("%s blocks the change set", async (_n, fields, rules) => {
    const { changeSet, result } = await propose(org, [loc], fields);
    expect(changeSet.status).toBe("blocked");
    expect(result.ok).toBe(false);
    expect(ids(changeSet)).toEqual(rules);
    expect(changeSet.can.apply).toBe(false);
    expect(await codeOf(run(org.manager, "profile.apply", { id: changeSet.id }))).toBe("CONFLICT");
    const cancelled = await run<{ changeSet: ChangeSet }>(org.manager, "profile.cancel", {
      id: changeSet.id,
    });
    expect(cancelled.changeSet.status).toBe("cancelled");
  });

  describe("typed service text", () => {
    const own = (displayName: string, description?: string) => ({
      freeFormServiceItem: {
        category: "categories/gcid:dentist",
        label: { displayName, ...(description ? { description } : {}) },
      },
    });
    const pv = async (item: unknown) =>
      (await preview(org, [loc], { serviceItems: [item] })).locations[0]!;

    it("a link in a service description blocks at preview and at propose, naming the service", async () => {
      const item = own("Whitening", "Book at https://example.test now");
      const p = await pv(item);
      const hit = p.guardrail!.violations.find((v) => v.ruleId === "U7.url");
      expect(hit?.severity).toBe("block");
      expect(hit?.message).toContain('Service "Whitening" description');
      const { changeSet, result } = await propose(org, [loc], { serviceItems: [item] });
      expect(result.ok).toBe(false);
      expect(changeSet.status).toBe("blocked");
      expect(ids(changeSet)).toEqual(["U7.url"]);
    });

    it("a link in an own service's name blocks; one in a Google-list service description blocks", async () => {
      const name = (await pv(own("Visit www.example.test"))).guardrail!.violations;
      expect(name.find((v) => v.ruleId === "U7.url")?.message).toContain("Service name");
      const structured = (
        await pv({ structuredServiceItem: { serviceTypeId: "job_type_id:cleaning", description: "See https://example.test" } })
      ).guardrail!.violations;
      expect(structured.find((v) => v.ruleId === "U7.url")?.message).toContain("job_type_id:cleaning");
    });

    it("a service already on Google with a link never blocks an edit to another service; changing it does", async () => {
      const legacy = own("Legacy", "Old text with https://example.test in it");
      const l2 = await org.mkLoc(org.a);
      await mock.updateLocation(l2.google, { serviceItems: [legacy] }, ["serviceItems"]);
      const at = async (items: unknown[]) =>
        (await preview(org, [l2], { serviceItems: items })).locations[0]!.guardrail!;
      const other = await at([legacy, own("Whitening", "A careful clean.")]);
      expect(other.ok).toBe(true);
      expect(other.violations.filter((v) => v.ruleId === "U7.url")).toEqual([]);
      const edited = await at([own("Legacy", "New text with https://example.test in it"), own("Whitening")]);
      expect(edited.ok).toBe(false);
      expect(edited.violations.find((v) => v.ruleId === "U7.url")?.message).toContain('Service "Legacy"');
    });

    it("a clean description passes; a banned word only warns", async () => {
      const clean = (await pv(own("Whitening", "A careful clean for healthy teeth."))).guardrail!;
      expect(clean.ok).toBe(true);
      expect(clean.violations).toEqual([]);
      const warned = (await pv(own("Whitening", "A comprehensive clean."))).guardrail!;
      expect(warned.ok).toBe(true);
      const w = warned.violations.find((v) => v.ruleId === "U8.style");
      expect(w?.severity).toBe("warn");
      expect(w?.message).toContain('Service "Whitening" description');
    });
  });

  it("a warning does not block; a clean one waits for approval and stores the snapshot", async () => {
    const warn = await propose(org, [loc], { phoneNumbers: { primaryPhone: "(713) 555-0142" } });
    expect(warn.changeSet.status).toBe("pending_approval");
    expect(warn.changeSet.guardrail!.violations.map((v) => v.ruleId)).toEqual(["PR.phone-format"]);
    const { changeSet } = await propose(org, [loc], { title: `New name ${uniq()}` });
    expect(changeSet.status).toBe("pending_approval");
    expect(changeSet.updateMask).toEqual(["title"]);
    const [t] = await targetsOf(changeSet.id);
    expect(t!.before).toMatchObject({ fields: { title: loc.row.name } });
    expect(t!.status).toBe("pending");
  });

  it("locations that would not change become no_change targets; nothing changing is refused", async () => {
    const other = await org.mkLoc(org.a);
    const title = `Same ${uniq()}`;
    mock.editLocation(other.google, { title }, ["title"]);
    const { changeSet } = await propose(org, [loc, other], { title });
    const st = Object.fromEntries(changeSet.targets.map((t) => [t.locationId, t.status]));
    expect(st).toEqual({ [loc.row.id]: "pending", [other.row.id]: "no_change" });
    const p = await preview(org, [other], { title });
    expect(
      await codeOf(
        run(org.manager, "profile.propose", {
          workspaceId: org.a,
          locationIds: [other.row.id],
          fields: { title },
          snapshots: [{ locationId: other.row.id, current: p.locations[0]!.current }],
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("refuses a missing snapshot, locations of two workspaces and inactive locations", async () => {
    const inB = await org.mkLoc(org.b);
    const gone = await org.mkLoc(org.a, { status: "inactive" });
    expect(await codeOf(preview(org, [loc, inB], { title: "X" }))).toBe("INVALID_INPUT");
    expect(await codeOf(preview(org, [gone], { title: "X" }))).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        run(org.manager, "profile.propose", {
          workspaceId: org.a,
          locationIds: [loc.row.id],
          fields: { title: "X" },
          snapshots: [{ locationId: inB.row.id, current: {} }],
        }),
      ),
    ).toBe("INVALID_INPUT");
  });
});

describe("approve and apply: the happy path", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("approved -> queued (one job, nothing sent) -> job -> applied; the mock changed; minimal mask", async () => {
    const description = `Family dentistry ${uniq().replace(/\d/g, "q")}.`;
    const fields = {
      title: loc.row.name, // unchanged, must not be written
      description,
      regularHours: hours(18),
      attributes: { "attributes/has_parking": { values: [true] } },
    };
    const id = await approved(org, [loc], fields);
    const [t] = await targetsOf(id);
    const before = mock.callCount;
    const queued = await run<{ jobsQueued: number; changeSet: ChangeSet }>(
      org.manager,
      "profile.apply",
      { id },
    );
    expect(queued.jobsQueued).toBe(1);
    expect(queued.changeSet.status).toBe("queued");
    expect(await jobsFor(t!.id)).toBe(1);
    expect(mock.callCount).toBe(before); // no Google call inside the action

    expect(await processProfileApply(db, { targetId: t!.id }, { client })).toBe("applied");
    const cs = await getCs(org, id);
    expect(cs.status).toBe("applied");
    expect(cs.targets[0]).toMatchObject({ status: "applied", error: null });

    const live = await mock.getLocation(loc.google);
    expect(live.profile?.description).toBe(description);
    expect(live.regularHours?.periods.find((p) => p.openDay === "TUESDAY")?.closeTime).toEqual({
      hours: 18,
      minutes: 0,
    });
    const upd = writes("updateLocation", loc.google);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.args[2]).toEqual(["profile", "regularHours"]); // title was not in the mask
    expect(upd[0]!.args[1]).not.toHaveProperty("title");
    const attr = writes("updateAttributes", `${loc.google}/attributes`);
    expect(attr).toHaveLength(1);
    expect(attr[0]!.args[2]).toEqual(["attributes/has_parking"]);
    expect(
      (await mock.getAttributes(`${loc.google}/attributes`)).attributes!.map((a) => a.name),
    ).toContain("attributes/has_parking");
  });

  it("audit rows carry field names, masks and a hash, never the values", async () => {
    const secret = `Secret wording ${uniq().replace(/\d/g, "q")}.`;
    const id = await approved(org, [loc], { description: secret });
    await applyAll(org, id);
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId));
    const mine = rows.filter((r) => JSON.stringify(r.after).includes(id));
    expect(mine.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "profile.proposed",
        "profile.approved",
        "profile.apply_requested",
        "profile.target_applied",
        "profile.applied",
      ]),
    );
    expect(JSON.stringify(rows.map((r) => [r.before, r.after]))).not.toContain(secret);
    const proposed = mine.find((r) => r.action === "profile.proposed")!;
    expect(proposed.after).toMatchObject({
      fieldNames: ["description"],
      updateMask: ["profile"],
      fieldsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(mine.find((r) => r.action === "profile.target_applied")!.surface).toBe("worker");
  });

  it("only an approved change set can be applied; a second apply and a cancel after queueing are refused", async () => {
    const { changeSet } = await propose(org, [loc], { title: `T ${uniq()}` });
    expect(await codeOf(run(org.manager, "profile.apply", { id: changeSet.id }))).toBe("CONFLICT");
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    await run(org.manager, "profile.apply", { id: changeSet.id });
    expect(await codeOf(run(org.manager, "profile.apply", { id: changeSet.id }))).toBe("CONFLICT");
    expect(await codeOf(run(org.manager, "profile.cancel", { id: changeSet.id }))).toBe("CONFLICT");
  });

  it("reject cancels with the reason; cancel skips the pending targets", async () => {
    const a = await propose(org, [loc], { title: `R ${uniq()}` });
    const rej = await run<{ changeSet: ChangeSet }>(org.approverA, "profile.reject", {
      id: a.changeSet.id,
      reason: "wrong name",
    });
    expect(rej.changeSet.status).toBe("cancelled");
    const [row] = await db
      .select()
      .from(profileChangeSets)
      .where(eq(profileChangeSets.id, a.changeSet.id));
    expect(row!.rejectReason).toBe("wrong name");
    expect((await targetsOf(a.changeSet.id))[0]!.status).toBe("skipped");
    const b = await propose(org, [loc], { title: `C ${uniq()}` });
    await run(org.manager, "profile.cancel", { id: b.changeSet.id });
    expect((await getCs(org, b.changeSet.id)).status).toBe("cancelled");
  });
});

describe("conflicts, re-runs and the guardrails at send", () => {
  let org: Org;
  beforeAll(async () => {
    org = await makeOrg();
  });

  it("Google changed a masked field between preview and apply: failed `conflict`, nothing written", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], {
      websiteUri: "https://new.example.test",
      title: `N ${uniq()}`,
    });
    mock.editLocation(loc.google, { websiteUri: "https://someone-else.example.test" }, [
      "websiteUri",
    ]);
    const { results } = await applyAll(org, id);
    expect(results).toEqual(["failed"]);
    const cs = await getCs(org, id);
    expect(cs.status).toBe("failed");
    expect(cs.targets[0]).toMatchObject({ status: "failed", error: "conflict" });
    expect(writes("updateLocation", loc.google)).toHaveLength(0);
    expect((await mock.getLocation(loc.google)).websiteUri).toBe(
      "https://someone-else.example.test",
    );
  });

  it("a changed attribute is a conflict too", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], {
      attributes: { "attributes/has_wifi": { values: [false] } },
    });
    mock.editAttribute(loc.google, {
      name: "attributes/has_wifi",
      valueType: "BOOL",
      values: ["x"],
    });
    await applyAll(org, id);
    expect((await getCs(org, id)).targets[0]).toMatchObject({
      status: "failed",
      error: "conflict",
    });
    expect(writes("updateAttributes")).not.toContainEqual(
      expect.objectContaining({
        args: [`${loc.google}/attributes`, expect.anything(), ["attributes/has_wifi"]],
      }),
    );
  });

  it("a changed field OUTSIDE the mask is not a conflict", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], { title: `Mine ${uniq()}` });
    mock.editLocation(loc.google, { websiteUri: "https://elsewhere.example.test" }, ["websiteUri"]);
    expect((await applyAll(org, id)).results).toEqual(["applied"]);
  });

  it("re-running a finished job writes nothing; a crashed settle is recognised as already applied", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], { title: `Idem ${uniq()}` });
    await applyAll(org, id);
    const [t] = await targetsOf(id);
    expect(writes("updateLocation", loc.google)).toHaveLength(1);
    expect(await processProfileApply(db, { targetId: t!.id }, { client })).toBe("ignored");
    // As if the process died after Google applied but before the target was settled.
    await db
      .update(profileChangeTargets)
      .set({ status: "pending" })
      .where(eq(profileChangeTargets.id, t!.id));
    await db
      .update(profileChangeSets)
      .set({ status: "queued" })
      .where(eq(profileChangeSets.id, id));
    expect(await processProfileApply(db, { targetId: t!.id }, { client })).toBe("applied");
    expect(writes("updateLocation", loc.google)).toHaveLength(1);
    expect((await getCs(org, id)).status).toBe("applied");
  });

  it("the guardrails run again at send: a stored value that now fails is not written", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], { description: "Fine description." });
    const [t] = await targetsOf(id);
    await db
      .update(profileChangeTargets)
      .set({ after: { fields: { description: "z".repeat(900) }, attributes: {} } })
      .where(eq(profileChangeTargets.id, t!.id));
    await applyAll(org, id);
    const cs = await getCs(org, id);
    expect(cs.targets[0]).toMatchObject({
      status: "failed",
      error: "guardrail_blocked:PR.description-length",
    });
    expect(cs.status).toBe("failed");
    expect(writes("updateLocation", loc.google)).toHaveLength(0);
  });

  it("publish refuses values that differ from the ones that passed the guardrails", async () => {
    const loc = await org.mkLoc(org.a);
    const snap = snapshotFromGoogle(await mock.getLocation(loc.google), null);
    const a = computeDiff(snap, desiredValues({ title: "One" })).after;
    const b = computeDiff(snap, desiredValues({ title: "Two" })).after;
    const { ctx, result } = checkProfile(a, { name: "x", phone: null });
    const passed = assertPassed(result, guardrailSubject(ctx));
    expect(() =>
      publishProfileFields(
        client,
        { orgId: org.orgId, changeSetId: "c", locationId: "l", locationName: loc.google },
        b,
        ["title"],
        passed,
      ),
    ).toThrow(/differ/);
    expect(profileGuardrailContext(a, { name: "x", phone: null }).reply).toBe("");
  });

  it("a Google 4xx fails only that location", async () => {
    const loc = await org.mkLoc(org.a);
    const id = await approved(org, [loc], { title: `E ${uniq()}` });
    mock.failNext(1, () => new GoogleApiError(400, {}), "updateLocation");
    await applyAll(org, id);
    expect((await getCs(org, id)).targets[0]).toMatchObject({
      status: "failed",
      error: "google_http_400",
    });
  });
});

describe("address, store code and social links round-trip through preview, approval and apply (L5)", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const address = {
    regionCode: "US",
    postalCode: "75940",
    administrativeArea: "TX",
    locality: "Rivermoor",
    addressLines: ["100 Main St", "Suite 4"],
  };

  it("an address change shows the re-verification warning at preview and on the change set, then applies", async () => {
    const fields = { storefrontAddress: address, storeCode: `LPC-${uniq()}` };
    const p = (await preview(org, [loc], fields)).locations[0]!;
    expect(p.updateMask).toEqual(["storeCode", "storefrontAddress"]);
    expect(p.guardrail?.ok).toBe(true);
    expect(p.guardrail?.violations.map((v) => v.ruleId)).toEqual(["PR.address-reverification"]);

    const id = await approved(org, [loc], fields);
    const cs = await getCs(org, id);
    expect(cs.guardrail?.violations.map((v) => v.ruleId)).toEqual(["PR.address-reverification"]);

    expect((await applyAll(org, id)).results).toEqual(["applied"]);
    const live = await mock.getLocation(loc.google);
    expect(live.storefrontAddress).toEqual(address);
    expect(live.storeCode).toBe(fields.storeCode);
    const upd = writes("updateLocation", loc.google).at(-1)!;
    expect(upd.args[2]).toEqual(["storeCode", "storefrontAddress"]);
  });

  it("editing only the street line sends the address parts the editor does not show back unchanged", async () => {
    const own = await org.mkLoc(org.a);
    const rich = { ...address, sublocality: "Downtown", languageCode: "en", organization: "Clinic" };
    await mock.updateLocation(own.google, { storefrontAddress: rich }, ["storefrontAddress"]);
    const snap = (await run<{ profile: { fields: Record<string, unknown> } }>(org.manager, "profile.get", { locationId: own.row.id })).profile;
    const current = snap.fields.storefrontAddress as Record<string, unknown>;
    expect(current).toMatchObject({ sublocality: "Downtown", languageCode: "en" });

    const edited = { ...current, addressLines: ["200 Elm St"] };
    const p = (await preview(org, [own], { storefrontAddress: edited })).locations[0]!;
    expect(p.changes.map((c) => c.field)).toEqual(["storefrontAddress"]);
    await applyAll(org, await approved(org, [own], { storefrontAddress: edited }));
    const sent = writes("updateLocation", own.google).at(-1)!.args[1] as { storefrontAddress: Record<string, unknown> };
    expect(sent.storefrontAddress).toEqual({ ...rich, addressLines: ["200 Elm St"] });
    expect((await mock.getLocation(own.google)).storefrontAddress).toEqual({ ...rich, addressLines: ["200 Elm St"] });
  });

  it("a store code alone has no re-verification warning; null clears it; unchanged is no change", async () => {
    const code = `SC-${uniq()}`;
    const p = (await preview(org, [loc], { storeCode: code })).locations[0]!;
    expect(p.guardrail?.violations).toEqual([]);
    await applyAll(org, await approved(org, [loc], { storeCode: code }));
    expect((await mock.getLocation(loc.google)).storeCode).toBe(code);
    expect((await preview(org, [loc], { storeCode: code, storefrontAddress: address })).locations[0]!.noChange).toBe(true);

    await applyAll(org, await approved(org, [loc], { storeCode: null }));
    expect((await mock.getLocation(loc.google)).storeCode).toBeUndefined();
  });

  it("an address without a line or a city is blocked; a missing country is refused as input", async () => {
    const bad = (await preview(org, [loc], { storefrontAddress: { regionCode: "US", postalCode: "1" } })).locations[0]!;
    expect(bad.guardrail?.ok).toBe(false);
    expect(bad.guardrail?.violations.map((v) => v.ruleId)).toEqual(["PR.address-reverification", "PR.address-valid"]);
    expect(await codeOf(preview(org, [loc], { storefrontAddress: { postalCode: "1" } }))).toBe("INVALID_INPUT");
    expect(
      (await preview(org, [loc], { storeCode: "x".repeat(65) })).locations[0]!.guardrail?.violations.map((v) => v.ruleId),
    ).toEqual(["PR.store-code-length"]);
  });

  it("Facebook and Instagram link attributes round-trip, and clearing one deletes it", async () => {
    const attrs = {
      "attributes/url_facebook": { uriValues: [{ uri: "https://facebook.com/clinic" }] },
      "attributes/url_instagram": { uriValues: [{ uri: "https://instagram.com/clinic" }] },
    };
    await applyAll(org, await approved(org, [loc], { attributes: attrs }));
    const got = (await mock.getAttributes(`${loc.google}/attributes`)).attributes!;
    expect(got.find((a) => a.name === "attributes/url_facebook")?.uriValues).toEqual([{ uri: "https://facebook.com/clinic" }]);
    expect(got.find((a) => a.name === "attributes/url_instagram")?.uriValues).toEqual([{ uri: "https://instagram.com/clinic" }]);

    await applyAll(org, await approved(org, [loc], { attributes: { "attributes/url_instagram": null } }));
    const after = (await mock.getAttributes(`${loc.google}/attributes`)).attributes!.map((a) => a.name);
    expect(after).toContain("attributes/url_facebook");
    expect(after).not.toContain("attributes/url_instagram");
  });
});

describe("locationManagers.list (L5)", () => {
  it("reads the managers live on demand: names, roles, pending invitations", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.a);
    mock.setLocationAdmins(loc.google, [
      { admin: "Rosa Diaz", role: "PRIMARY_OWNER" },
      { admin: "new.person@example.test", role: "MANAGER", pendingInvitation: true },
      { admin: "Someone", role: "ADMIN_ROLE_UNSPECIFIED" },
    ]);
    const before = mock.callCount;
    const r = await run<{ managers: { name: string; role: string; pendingInvitation: boolean }[] }>(
      org.manager,
      "locationManagers.list",
      { locationId: loc.row.id },
    );
    expect(r.managers).toEqual([
      { name: "Rosa Diaz", role: "PRIMARY_OWNER", pendingInvitation: false },
      { name: "new.person@example.test", role: "MANAGER", pendingInvitation: true },
      { name: "Someone", role: "OTHER", pendingInvitation: false },
    ]);
    expect(mock.callCount).toBe(before + 1);
    expect(writes("listLocationAdmins", loc.google)).toHaveLength(1);
    // profile.get does not read the managers.
    await run(org.manager, "profile.get", { locationId: loc.row.id });
    expect(writes("listLocationAdmins", loc.google)).toHaveLength(1);
  });

  it("a viewer of another workspace cannot read them", async () => {
    const org = await makeOrg();
    const loc = await org.mkLoc(org.b);
    expect(await codeOf(run(org.viewerA, "locationManagers.list", { locationId: loc.row.id }))).not.toBe("no error");
  });
});

describe("bulk edits", () => {
  it("partial failure: per-location results and partially_applied", async () => {
    const org = await makeOrg();
    const [l1, l2, l3, l4] = [
      await org.mkLoc(org.a),
      await org.mkLoc(org.a),
      await org.mkLoc(org.a),
      await org.mkLoc(org.a),
    ] as [Loc, Loc, Loc, Loc];
    const site = `https://bulk-${uniq()}.example.test`;
    const same = `https://same.example.test`;
    mock.editLocation(l4.google, { websiteUri: same }, ["websiteUri"]);
    const { changeSet } = await propose(org, [l1, l2, l3, l4], {
      websiteUri: site,
      description: "Our team cares.",
    });
    expect(changeSet.status).toBe("pending_approval");
    expect(changeSet.targets).toHaveLength(4);
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    mock.editLocation(l2.google, { websiteUri: "https://changed.example.test" }, ["websiteUri"]); // conflict
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, l3.row.id)); // skipped
    const { results } = await applyAll(org, changeSet.id);
    expect(results.sort()).toEqual(["applied", "applied", "failed", "skipped"]);
    const cs = await getCs(org, changeSet.id);
    expect(cs.status).toBe("partially_applied");
    const by = Object.fromEntries(cs.targets.map((t) => [t.locationId, [t.status, t.error]]));
    expect(by).toEqual({
      [l1.row.id]: ["applied", null],
      [l2.row.id]: ["failed", "conflict"],
      [l3.row.id]: ["skipped", "location_inactive"],
      [l4.row.id]: ["applied", null],
    });
    expect((await mock.getLocation(l1.google)).websiteUri).toBe(site);
    expect((await mock.getLocation(l2.google)).websiteUri).toBe("https://changed.example.test");
    expect((await mock.getLocation(l4.google)).profile?.description).toBe("Our team cares.");
    // Per-location minimal masks: both changed everywhere.
    expect(cs.targets.find((t) => t.locationId === l1.row.id)!.updateMask).toEqual([
      "profile",
      "websiteUri",
    ]);
  });

  it("every target applied -> applied; none applied -> failed", async () => {
    const org = await makeOrg();
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const ok = await approved(org, [l1, l2], { title: `Bulk ${uniq()}` });
    await applyAll(org, ok);
    expect((await getCs(org, ok)).status).toBe("applied");
  });
});

describe("bulk edit: add services without losing the rest", () => {
  const price = (units: string) => ({ currencyCode: "USD", units });
  const free = (category: string, displayName: string, units?: string) => ({
    freeFormServiceItem: { category, label: { displayName } },
    ...(units ? { price: price(units) } : {}),
  });
  const structured = (units: string) => ({
    structuredServiceItem: { serviceTypeId: "job_type_id:cleaning", description: "Deep clean, 60 min" },
    price: price(units),
  });
  const A = "categories/gcid:dentist";
  const B = "categories/gcid:orthodontist";
  const added = free(A, "Teeth whitening");
  const itemsOf = async (l: Loc) => (await mock.getLocation(l.google)).serviceItems ?? [];

  it("adds once per location, keeps every existing item, and passes the conflict check", async () => {
    const org = await makeOrg();
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    // Different lists per location: priced items in two categories plus a structured one with a description.
    const list1 = [free(A, "Checkup", "80"), free(A, "Filling", "150"), free(B, "Braces", "3000"), structured("120")];
    const list2 = [free(A, "Checkup", "95"), free(B, "Retainer", "200"), structured("130"), free(B, "Aligners", "4000")];
    await mock.updateLocation(l1.google, { serviceItems: list1 }, ["serviceItems"]);
    await mock.updateLocation(l2.google, { serviceItems: list2 }, ["serviceItems"]);
    const before = [await itemsOf(l1), await itemsOf(l2)];
    expect(before.map((b) => b.length)).toEqual([4, 4]);

    const locs = [l1, l2];
    const p = await run<{ locations: PreviewLoc[] }>(org.manager, "profile.preview", {
      locationIds: locs.map((l) => l.row.id),
      fields: {},
      addServiceItems: [added],
    });
    expect(p.locations.map((l) => l.updateMask)).toEqual([["serviceItems"], ["serviceItems"]]);
    const { changeSet } = await run<{ changeSet: ChangeSet }>(org.manager, "profile.propose", {
      workspaceId: org.a,
      locationIds: locs.map((l) => l.row.id),
      fields: {},
      addServiceItems: [added],
      snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
    });
    expect(changeSet.status).toBe("pending_approval");
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    const { results } = await applyAll(org, changeSet.id);
    expect(results).toEqual(["applied", "applied"]); // no `conflict`

    for (const [i, l] of locs.entries()) {
      const after = await itemsOf(l);
      expect(after).toHaveLength(before[i]!.length + 1);
      for (const old of before[i]!) expect(after).toContainEqual(old); // price, category, description intact
      expect(after).toContainEqual(added);
      expect(after.filter((x) => x.freeFormServiceItem?.label.displayName === "Teeth whitening")).toHaveLength(1);
    }

    // Adding the same service again changes nothing.
    const again = await run<{ locations: PreviewLoc[] }>(org.manager, "profile.preview", {
      locationIds: locs.map((l) => l.row.id),
      fields: {},
      addServiceItems: [added],
    });
    expect(again.locations.every((l) => l.noChange)).toBe(true);
  });

  it("refuses addServiceItems together with a whole serviceItems value", async () => {
    const org = await makeOrg();
    const l1 = await org.mkLoc(org.a);
    const code = await codeOf(
      run(org.manager, "profile.preview", {
        locationIds: [l1.row.id],
        fields: { serviceItems: [added] },
        addServiceItems: [added],
      }),
    );
    expect(code).toBe("INVALID_INPUT");
  });
});

describe("bulk edit: add categories without losing the rest", () => {
  const cat = (id: string) => ({ name: `categories/gcid:${id}`, displayName: id });
  const A = "categories/gcid:dentist";
  const B = "categories/gcid:orthodontist";
  const NEW = "categories/gcid:cosmetic_dentist";
  const free = (category: string, displayName: string) => ({
    freeFormServiceItem: { category, label: { displayName } },
  });
  const catsOf = async (l: Loc) => (await mock.getLocation(l.google)).categories;
  const setCats = (l: Loc, primary: string, more: string[]) =>
    mock.updateLocation(
      l.google,
      { categories: { primaryCategory: cat(primary), additionalCategories: more.map(cat) } },
      ["categories"],
    );
  type SvcLoc = PreviewLoc & { serviceAdd: { send: number[]; skipped: { index: number; reason: string }[] } | null };

  it("adding one category to 3 locations keeps their existing categories", async () => {
    const org = await makeOrg();
    const locs = [await org.mkLoc(org.a), await org.mkLoc(org.a), await org.mkLoc(org.a)];
    await setCats(locs[0]!, "dentist", ["orthodontist"]);
    await setCats(locs[1]!, "orthodontist", []);
    await setCats(locs[2]!, "dentist", ["cosmetic_dentist"]); // already has it
    const before = await Promise.all(locs.map(catsOf));

    const input = { locationIds: locs.map((l) => l.row.id), fields: {}, addCategories: [{ name: NEW }] };
    const p = await run<{ locations: PreviewLoc[] }>(org.manager, "profile.preview", input);
    expect(p.locations.map((l) => l.noChange)).toEqual([false, false, true]);
    const { changeSet } = await run<{ changeSet: ChangeSet }>(org.manager, "profile.propose", {
      ...input,
      workspaceId: org.a,
      snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
    });
    expect(changeSet.status).toBe("pending_approval");
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    const { results } = await applyAll(org, changeSet.id);
    expect(results).toEqual(["applied", "applied"]); // no `conflict`, the third had nothing to do

    const names = (c: Awaited<ReturnType<typeof catsOf>>) => [
      c?.primaryCategory?.name,
      ...(c?.additionalCategories ?? []).map((x) => x.name),
    ];
    for (const [i, l] of locs.entries()) {
      const after = await catsOf(l);
      expect(after?.primaryCategory?.name).toBe(before[i]?.primaryCategory?.name); // primary kept
      for (const n of names(before[i])) expect(names(after)).toContain(n); // every old one kept
      expect(names(after).filter((n) => n === NEW)).toHaveLength(1); // added once
    }
  });

  it("refuses addCategories together with a whole categories value", async () => {
    const org = await makeOrg();
    const l1 = await org.mkLoc(org.a);
    expect(
      await codeOf(
        run(org.manager, "profile.preview", {
          locationIds: [l1.row.id],
          fields: { categories: { primaryCategory: { name: A } } },
          addCategories: [{ name: NEW }],
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("mergeCategories keeps the primary, skips repeats, and refuses a location with no primary", () => {
    const cur = { primaryCategory: { name: A }, additionalCategories: [{ name: B }] };
    expect(mergeCategories(cur, [{ name: "gcid:dentist" }, { name: B }])).toBe(cur); // all already there
    expect(mergeCategories(cur, [{ name: NEW }, { name: NEW }])).toEqual({
      primaryCategory: { name: A },
      additionalCategories: [{ name: B }, { name: NEW }],
    });
    expect(() => mergeCategories(null, [{ name: NEW }])).toThrow(/no primary category/);
  });

  it("add-mode services: a location lacking the category is skipped and flagged, not sent", async () => {
    const org = await makeOrg();
    const has = await org.mkLoc(org.a);
    const lacks = await org.mkLoc(org.a);
    await setCats(has, "dentist", []);
    await setCats(lacks, "orthodontist", []);
    const add = [free(A, "Teeth whitening")];
    const beforeLacks = (await mock.getLocation(lacks.google)).serviceItems ?? [];

    const p = await run<{ locations: SvcLoc[] }>(org.manager, "profile.preview", {
      locationIds: [has.row.id, lacks.row.id],
      fields: {},
      addServiceItems: add,
      skipUnofferedServices: true,
    });
    expect(p.locations[0]!.serviceAdd).toEqual({ send: [0], alreadyThere: [], skipped: [] });
    expect(p.locations[1]!.serviceAdd).toEqual({
      send: [],
      alreadyThere: [],
      skipped: [{ index: 0, reason: "category_not_on_location" }],
    });
    expect(p.locations[1]!.noChange).toBe(true);
    const { changeSet } = await run<{ changeSet: ChangeSet }>(org.manager, "profile.propose", {
      workspaceId: org.a,
      locationIds: [has.row.id, lacks.row.id],
      fields: {},
      addServiceItems: add,
      skipUnofferedServices: true,
      serviceAddSend: p.locations.map((l) => ({ locationId: l.locationId, indexes: l.serviceAdd?.send ?? [] })),
      snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
    });
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    expect((await applyAll(org, changeSet.id)).results).toEqual(["applied"]);
    expect(await mock.getLocation(has.google)).toMatchObject({ serviceItems: [add[0]] });
    expect((await mock.getLocation(lacks.google)).serviceItems ?? []).toEqual(beforeLacks); // nothing sent
  });

  it("a service in a category that the same change adds is not skipped", async () => {
    const org = await makeOrg();
    const l = await org.mkLoc(org.a);
    await setCats(l, "dentist", []);
    const svc = free(NEW, "Veneers");
    const p = await run<{ locations: SvcLoc[] }>(org.manager, "profile.preview", {
      locationIds: [l.row.id],
      fields: {},
      addCategories: [{ name: NEW }],
      addServiceItems: [svc],
      skipUnofferedServices: true,
    });
    expect(p.locations[0]!.serviceAdd).toEqual({ send: [0], alreadyThere: [], skipped: [] });
    expect(p.locations[0]!.changes.map((c) => c.field).sort()).toEqual(["categories", "serviceItems"]);
  });
});

describe("bulk edit: services follow a categories Replace in the same edit", () => {
  it("a service in the new primary is sent; one in a category being removed is skipped", async () => {
    const org = await makeOrg();
    const l = await org.mkLoc(org.a); // mock default: dentist only
    const ORTHO = "categories/gcid:orthodontist";
    const svc = (category: string, displayName: string) => ({ freeFormServiceItem: { category, label: { displayName } } });
    const p = await run<{ locations: (PreviewLoc & { serviceAdd: { send: number[]; skipped: { index: number }[] } | null })[] }>(
      org.manager,
      "profile.preview",
      {
        locationIds: [l.row.id],
        fields: { categories: { primaryCategory: { name: ORTHO } } },
        addServiceItems: [svc(ORTHO, "Braces"), svc("categories/gcid:dentist", "Checkup")],
        skipUnofferedServices: true,
      },
    );
    expect(p.locations[0]!.serviceAdd!.send).toEqual([0]);
    expect(p.locations[0]!.serviceAdd!.skipped.map((x) => x.index)).toEqual([1]);
  });
});

describe("copy services to other locations", () => {
  const price = (units: string) => ({ currencyCode: "USD", units });
  const free = (category: string, displayName: string, units?: string) => ({
    freeFormServiceItem: { category, label: { displayName } },
    ...(units ? { price: price(units) } : {}),
  });
  const A = "categories/gcid:dentist";
  const ORTHO = "categories/gcid:orthodontist";
  const whitening = free(A, "Teeth whitening", "250");
  const veneers = free(A, "Veneers", "900");
  const cleaning = {
    structuredServiceItem: { serviceTypeId: "job_type_id:teeth_cleaning", description: "Scale and polish" },
    price: price("120"),
  };
  type Plan = { send: number[]; alreadyThere: number[]; skipped: { index: number; reason: string }[] };
  type CopyLoc = PreviewLoc & { serviceAdd: Plan | null };
  const itemsOf = async (l: Loc) => (await mock.getLocation(l.google)).serviceItems ?? [];
  const setItems = (l: Loc, items: unknown[]) =>
    mock.updateLocation(l.google, { serviceItems: items as never }, ["serviceItems"]);
  const makeOrtho = (l: Loc) =>
    mock.updateLocation(
      l.google,
      { categories: { primaryCategory: { name: ORTHO, displayName: "Orthodontist" } } },
      ["categories"],
    );
  const copyPreview = (org: Org, locs: Loc[], add: unknown[], skip = true) =>
    run<{ locations: CopyLoc[] }>(org.manager, "profile.preview", {
      locationIds: locs.map((l) => l.row.id),
      fields: {},
      addServiceItems: add,
      ...(skip ? { skipUnofferedServices: true } : {}),
    });
  const copyPropose = (org: Org, locs: Loc[], add: unknown[], p: { locations: CopyLoc[] }, send?: unknown) =>
    run<{ changeSet: ChangeSet }>(org.manager, "profile.propose", {
      workspaceId: org.a,
      locationIds: locs.map((l) => l.row.id),
      fields: {},
      addServiceItems: add,
      skipUnofferedServices: true,
      serviceAddSend:
        send ?? p.locations.map((l) => ({ locationId: l.locationId, indexes: l.serviceAdd?.send ?? [] })),
      snapshots: p.locations.map((l) => ({ locationId: l.locationId, current: l.current })),
    });

  it("planServiceAdds: free-form category compare ignores the categories/ prefix; repeats are no-ops", () => {
    const snap = {
      fields: { categories: { primaryCategory: { name: A } }, serviceItems: null },
      attributes: {},
    };
    const bare = free("gcid:dentist", "Bare id");
    const plan = planServiceAdds(snap, [bare, bare, free(ORTHO, "Braces")], { checkOffers: true });
    expect(plan.send).toEqual([0]);
    expect(plan.alreadyThere).toEqual([1]);
    expect(plan.skipped).toEqual([{ index: 2, reason: "category_not_on_location" }]);
    // Without the check only duplicates are set aside (Bulk edit add mode).
    expect(planServiceAdds(snap, [bare, free(ORTHO, "Braces")], { checkOffers: false }).send).toEqual([0, 1]);
  });

  it("copies a priced service and a category's services to 2 locations; a target lacking the category is flagged and skipped", async () => {
    const org = await makeOrg();
    const b = await org.mkLoc(org.a);
    const c = await org.mkLoc(org.a);
    await makeOrtho(c);
    await setItems(b, [free(A, "Checkup", "80"), veneers, free(ORTHO, "Braces", "3000")]);
    await setItems(c, [free(ORTHO, "Retainer", "200")]);
    const beforeB = await itemsOf(b);
    const beforeC = await itemsOf(c);

    // One priced service.
    const one = await copyPreview(org, [b, c], [whitening]);
    const [pb, pc] = one.locations;
    expect(pb!.serviceAdd).toEqual({ send: [0], alreadyThere: [], skipped: [] });
    expect(pc!.serviceAdd).toEqual({ send: [], alreadyThere: [], skipped: [{ index: 0, reason: "category_not_on_location" }] });
    expect(pc!.noChange).toBe(true);

    // A category's services: a free-form one, a structured one, and one B already has.
    const add = [whitening, cleaning, veneers];
    const p = await copyPreview(org, [b, c], add);
    expect(p.locations[0]!.serviceAdd).toEqual({ send: [0, 1], alreadyThere: [2], skipped: [] });
    expect(p.locations[1]!.serviceAdd).toEqual({
      send: [],
      alreadyThere: [],
      skipped: [
        { index: 0, reason: "category_not_on_location" },
        { index: 1, reason: "type_not_offered" },
        { index: 2, reason: "category_not_on_location" },
      ],
    });
    const cWrites = writes("updateLocation", c.google).length;
    const { changeSet } = await copyPropose(org, [b, c], add, p);
    expect(changeSet.targets.map((t) => t.status).sort()).toEqual(["no_change", "pending"]);
    await run(org.approverA, "profile.approve", { id: changeSet.id });
    const { results } = await applyAll(org, changeSet.id);
    expect(results).toEqual(["applied"]);

    const afterB = await itemsOf(b);
    expect(afterB).toHaveLength(beforeB.length + 2); // whitening + cleaning; Veneers was already there
    for (const old of beforeB) expect(afterB).toContainEqual(old);
    expect(afterB).toContainEqual(whitening); // price carried
    expect(afterB).toContainEqual(cleaning); // structured, description and price carried
    expect(await itemsOf(c)).toEqual(beforeC); // nothing flagged was sent
    expect(writes("updateLocation", c.google)).toHaveLength(cWrites); // no write to C at all
  });

  it("an existing item keeps its own price when the copy carries another", async () => {
    const org = await makeOrg();
    const b = await org.mkLoc(org.a);
    await setItems(b, [free(A, "Teeth whitening", "199")]);
    const p = await copyPreview(org, [b], [whitening]);
    expect(p.locations[0]!.serviceAdd!.alreadyThere).toEqual([0]);
    expect(p.locations[0]!.noChange).toBe(true);
  });

  it("over the 300 cap: nothing is sent to that location and the items say why", async () => {
    const org = await makeOrg();
    const b = await org.mkLoc(org.a);
    await setItems(b, Array.from({ length: 299 }, (_, i) => free(A, `Service ${i}`)));
    const p = await copyPreview(org, [b], [whitening, veneers]);
    expect(p.locations[0]!.serviceAdd).toEqual({
      send: [],
      alreadyThere: [],
      skipped: [{ index: 0, reason: "over_cap" }, { index: 1, reason: "over_cap" }],
    });
    expect(p.locations[0]!.noChange).toBe(true);
  });

  it("without the flag Bulk edit add mode still sends a foreign category; propose cannot add what preview did not send", async () => {
    const org = await makeOrg();
    const c = await org.mkLoc(org.a);
    await makeOrtho(c);
    const bulk = await copyPreview(org, [c], [whitening], false);
    expect(bulk.locations[0]!.serviceAdd).toBeNull();
    expect(bulk.locations[0]!.changes.map((x) => x.field)).toEqual(["serviceItems"]);

    const b = await org.mkLoc(org.a);
    const p = await copyPreview(org, [b], [cleaning]);
    expect(p.locations[0]!.serviceAdd!.send).toEqual([0]);
    // A caller that sends no verdict for the structured item gets it dropped, so nothing changes.
    expect(await codeOf(copyPropose(org, [b], [cleaning], p, []))).toBe("INVALID_INPUT");
  });
});

describe("the per-location edit queue", () => {
  it("the 11th edit to one location in a minute waits (fake clock) while other locations proceed", async () => {
    const org = await makeOrg();
    const hot = await org.mkLoc(org.a);
    const cold = await org.mkLoc(org.a);
    const WINDOW = 60_000;
    // 2035: outside throttle.test.ts's 2031 range, whose setup must not touch these windows.
    const T0 = Math.floor(Date.UTC(2035, 5, 1) / WINDOW) * WINDOW;
    const clock = {
      t: T0 + 10_000,
      sleeps: [] as number[],
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.sleeps.push(ms);
        clock.t += ms;
      },
      random: () => 0.5,
    };
    const slow = new ThrottledGoogleClient(mock, db, clock);
    for (let i = 0; i < 10; i++) {
      const id = await approved(org, [hot], { title: `Hot ${i} ${uniq()}` });
      expect((await applyAll(org, id, slow)).results).toEqual(["applied"]);
    }
    expect(clock.sleeps).toEqual([]);
    const coldId = await approved(org, [cold], { title: `Cold ${uniq()}` });
    expect((await applyAll(org, coldId, slow)).results).toEqual(["applied"]);
    expect(clock.sleeps).toEqual([]); // another location is not held up
    const eleventh = await approved(org, [hot], { title: `Hot 11 ${uniq()}` });
    expect((await applyAll(org, eleventh, slow)).results).toEqual(["applied"]);
    expect(clock.sleeps).toEqual([50_000 + 125]); // waited for the next window, then wrote
    expect(writes("updateLocation", hot.google).length).toBeGreaterThanOrEqual(11);
  }, 60_000);
});

describe("roles and scoping", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("client roles are FORBIDDEN on the profile writes and on preview", async () => {
    const fields = { title: `Z ${uniq()}` };
    for (const who of [org.viewerA, org.approverA]) {
      expect(await codeOf(run(who, "profile.preview", { locationIds: [loc.row.id], fields }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(
          run(who, "profile.propose", {
            workspaceId: org.a,
            locationIds: [loc.row.id],
            fields,
            snapshots: [{ locationId: loc.row.id, current: {} }],
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(await codeOf(run(who, "profile.apply", { id: crypto.randomUUID() }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(run(who, "profile.cancel", { id: crypto.randomUUID() }))).toBe(
        "FORBIDDEN",
      );
    }
  });

  it("approval: client_approver in the workspace may, client_viewer and other workspaces may not", async () => {
    const { changeSet } = await propose(org, [loc], { title: `Ap ${uniq()}` });
    expect(await codeOf(run(org.viewerA, "profile.approve", { id: changeSet.id }))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(run(org.approverB, "profile.approve", { id: changeSet.id }))).toBe(
      "NOT_FOUND",
    );
    const seenByA = await run<{ changeSets: ChangeSet[] }>(
      org.approverA,
      "profile.changeSets.list",
      {
        status: "pending_approval",
      },
    );
    expect(seenByA.changeSets.map((c) => c.id)).toContain(changeSet.id);
    expect(seenByA.changeSets.find((c) => c.id === changeSet.id)!.can).toMatchObject({
      approve: true,
      apply: false,
    });
    const seenByB = await run<{ changeSets: ChangeSet[] }>(
      org.approverB,
      "profile.changeSets.list",
      {},
    );
    expect(seenByB.changeSets.map((c) => c.id)).not.toContain(changeSet.id);
    expect(await codeOf(run(org.approverB, "profile.changeSets.get", { id: changeSet.id }))).toBe(
      "NOT_FOUND",
    );
    await run(org.approverA, "profile.approve", { id: changeSet.id });
  });

  it("viewers can read the profile and change sets of their own workspace only", async () => {
    expect(await codeOf(run(org.viewerA, "profile.get", { locationId: loc.row.id }))).toBe(
      "no error",
    );
    expect(await codeOf(run(org.approverB, "profile.get", { locationId: loc.row.id }))).toBe(
      "NOT_FOUND",
    );
  });

  it("another organisation cannot see the change set", async () => {
    const other = await makeOrg();
    const { changeSet } = await propose(org, [loc], { title: `Org ${uniq()}` });
    expect(await codeOf(run(other.owner, "profile.changeSets.get", { id: changeSet.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(run(other.owner, "profile.get", { locationId: loc.row.id }))).toBe(
      "NOT_FOUND",
    );
  });
});
