import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { SUSPENSION_CHECKLIST } from "./config/suspension";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";
import { describeVoiceOfMerchant } from "./verification/state";

// The shared test database is also used by every other suite, often at the same time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type State = {
  standing: string;
  hasVoiceOfMerchant: boolean;
  hasBusinessAuthority: boolean;
  waitForVoiceOfMerchant: boolean;
  needsVerification: boolean;
  hasPendingVerification: boolean;
  complyWithGuidelines: boolean;
  recommendationReason: string | null;
  resolveOwnershipConflict: boolean;
  verifications: { method: string | null; state: string | null }[];
};
type Case = {
  id: string;
  status: string;
  reason: string;
  appealSubmittedAt: string | null;
  outcomeAt: string | null;
  outcomeNotes: string | null;
  checklistDone: number;
  checklistTotal: number;
  evidenceChecklist: { key: string; label: string; done: boolean; note: string }[];
};

beforeAll(() => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await sql.end();
});

describe("describeVoiceOfMerchant (pure)", () => {
  it("empty sub-states count by presence; absent booleans are false; the most urgent wins", () => {
    expect(describeVoiceOfMerchant({}).standing).toBe("unknown");
    expect(
      describeVoiceOfMerchant({ hasVoiceOfMerchant: true, hasBusinessAuthority: true }),
    ).toMatchObject({
      standing: "good_standing",
      waitForVoiceOfMerchant: false,
      needsVerification: false,
    });
    expect(describeVoiceOfMerchant({ waitForVoiceOfMerchant: {} })).toMatchObject({
      standing: "wait_for_review",
      waitForVoiceOfMerchant: true,
      hasVoiceOfMerchant: false,
    });
    expect(describeVoiceOfMerchant({ resolveOwnershipConflict: {} }).standing).toBe(
      "resolve_ownership_conflict",
    );
    expect(describeVoiceOfMerchant({ verify: {} })).toMatchObject({
      standing: "verify",
      hasPendingVerification: false,
    });
    const both = describeVoiceOfMerchant({
      hasVoiceOfMerchant: true,
      verify: { hasPendingVerification: true },
      complyWithGuidelines: { recommendationReason: "BUSINESS_LOCATION_SUSPENDED" },
    });
    expect(both).toMatchObject({
      standing: "comply_with_guidelines",
      recommendationReason: "BUSINESS_LOCATION_SUSPENDED",
      hasPendingVerification: true,
    });
  });
});

describe("verification.state (read only)", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const state = (actor = org.owner, l = loc) =>
    run<State>(actor, "verification.state", { locationId: l.row.id });

  it("reads Voice of Merchant and the verification attempts; viewers may read; nothing is written", async () => {
    mock.addVerification(loc.google, {
      method: "PHONE_CALL",
      state: "FAILED",
      createTime: "2026-09-01T00:00:00Z",
    });
    mock.addVerification(loc.google, {
      method: "ADDRESS",
      state: "PENDING",
      createTime: "2026-09-10T00:00:00Z",
    });
    const before = mock.callCount;
    const s = await state(org.viewerA);
    expect(s).toMatchObject({
      standing: "good_standing",
      hasVoiceOfMerchant: true,
      hasBusinessAuthority: true,
    });
    expect(s.verifications.map((v) => [v.method, v.state])).toEqual([
      ["PHONE_CALL", "FAILED"],
      ["ADDRESS", "PENDING"],
    ]);
    expect(mock.calls.slice(before).map((c) => c.method)).toEqual([
      "getVoiceOfMerchantState",
      "listVerifications",
    ]);
  });

  it("maps a suspended / under-review / conflicting listing", async () => {
    mock.setVoiceOfMerchantState(loc.google, {
      complyWithGuidelines: { recommendationReason: "BUSINESS_LOCATION_SUSPENDED" },
    });
    expect(await state()).toMatchObject({
      standing: "comply_with_guidelines",
      complyWithGuidelines: true,
      hasVoiceOfMerchant: false,
      recommendationReason: "BUSINESS_LOCATION_SUSPENDED",
    });
    mock.setVoiceOfMerchantState(loc.google, { waitForVoiceOfMerchant: {} });
    expect((await state()).standing).toBe("wait_for_review");
    mock.setVoiceOfMerchantState(loc.google, { resolveOwnershipConflict: {} });
    expect((await state()).resolveOwnershipConflict).toBe(true);
    mock.setVoiceOfMerchantState(loc.google, { verify: { hasPendingVerification: true } });
    expect(await state()).toMatchObject({ standing: "verify", hasPendingVerification: true });
  });

  it("another org, another workspace and an unlinked location", async () => {
    expect(await codeOf(state((await kit.makeOrg()).owner))).toBe("NOT_FOUND");
    expect(await codeOf(state(org.approverB))).toBe("NOT_FOUND"); // out of scope: existence is hidden
    const unlinked = await org.mkLoc(org.a, { googleLocationId: null });
    expect(await codeOf(state(org.owner, unlinked))).toBe("INVALID_INPUT");
  });
});

describe("suspension cases", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const create = (reason = "Suspended for 'quality guidelines'", actor = org.manager, l = loc) =>
    run<{ case: Case }>(actor, "suspension.cases.create", { locationId: l.row.id, reason }).then(
      (r) => r.case,
    );
  const update = (id: string, input: object, actor = org.manager) =>
    run<{ case: Case }>(actor, "suspension.cases.update", { id, ...input }).then((r) => r.case);
  const list = (input: object = {}, actor = org.owner) =>
    run<{ cases: Case[] }>(actor, "suspension.cases.list", input).then((r) => r.cases);

  it("create starts open with the whole checklist undone", async () => {
    const c = await create();
    expect(c).toMatchObject({
      status: "open",
      checklistDone: 0,
      checklistTotal: SUSPENSION_CHECKLIST.length,
    });
    expect(c.evidenceChecklist.map((i) => i.key)).toEqual(SUSPENSION_CHECKLIST.map((i) => i.key));
    expect(c.evidenceChecklist.every((i) => !i.done && i.note === "" && i.label.length > 0)).toBe(
      true,
    );
    expect((await list({ locationId: loc.row.id })).map((x) => x.id)).toContain(c.id);
  });

  it("checklist toggles and notes; unknown keys are rejected; the audit row has counts, not text", async () => {
    const c = await create("Reason with PRIVATE detail");
    const u = await update(c.id, {
      checklist: [
        { key: "business_license", done: true, note: "scan in Drive" },
        { key: "utility_bill", done: true },
      ],
    });
    expect(u.checklistDone).toBe(2);
    expect(u.evidenceChecklist.find((i) => i.key === "business_license")).toMatchObject({
      done: true,
      note: "scan in Drive",
    });
    const u2 = await update(c.id, { checklist: [{ key: "utility_bill", done: false }] });
    expect(u2.checklistDone).toBe(1);
    expect(
      await codeOf(update(c.id, { checklist: [{ key: "tax_return_2019", done: true }] })),
    ).toBe("INVALID_INPUT");
    const audits = (await kit.auditRows(org.orgId, "suspension.case_updated")).filter(
      (a) => (a.after as { locationId: string }).locationId === loc.row.id,
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits.map((a) => a.after))).not.toContain("scan in Drive");
    const created = await kit.auditRows(org.orgId, "suspension.case_created");
    expect(JSON.stringify(created.map((a) => a.after))).not.toContain("PRIVATE");
  });

  it("open -> appealed -> reinstated records the dates; there is no second appeal; a finished case is read only", async () => {
    const c = await create();
    expect(await codeOf(update(c.id, { appealSubmittedAt: "2026-10-01T00:00:00Z" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(update(c.id, { outcomeNotes: "too early" }))).toBe("INVALID_INPUT");
    const a = await update(c.id, { status: "appealed", appealSubmittedAt: "2026-10-01T09:00:00Z" });
    expect(a).toMatchObject({
      status: "appealed",
      appealSubmittedAt: "2026-10-01T09:00:00.000Z",
      outcomeAt: null,
    });
    expect(await codeOf(update(c.id, { status: "open" }))).toBe("CONFLICT");
    const fixed = await update(c.id, { appealSubmittedAt: "2026-10-02T09:00:00Z" });
    expect(fixed.appealSubmittedAt).toBe("2026-10-02T09:00:00.000Z");
    const r = await update(c.id, {
      status: "reinstated",
      outcomeAt: "2026-10-09T12:00:00Z",
      outcomeNotes: "Email from Google",
    });
    expect(r).toMatchObject({
      status: "reinstated",
      outcomeAt: "2026-10-09T12:00:00.000Z",
      outcomeNotes: "Email from Google",
    });
    expect(await codeOf(update(c.id, { status: "appealed" }))).toBe("CONFLICT");
    expect(
      await codeOf(update(c.id, { checklist: [{ key: "business_license", done: true }] })),
    ).toBe("CONFLICT");
    expect((await update(c.id, { outcomeNotes: "Email from Google, ref 123" })).outcomeNotes).toBe(
      "Email from Google, ref 123",
    );
  });

  it("an open case can be closed as lost directly, with the outcome date defaulted", async () => {
    const c = await create();
    const l = await update(c.id, { status: "closed_lost" });
    expect(l.status).toBe("closed_lost");
    expect(l.outcomeAt).not.toBeNull();
    expect(
      (await list({ status: "closed_lost", locationId: loc.row.id })).map((x) => x.id),
    ).toContain(c.id);
  });

  it("clients can read cases of their workspace but not write; other workspaces and orgs see nothing", async () => {
    const c = await create();
    expect((await list({ locationId: loc.row.id }, org.viewerA)).map((x) => x.id)).toContain(c.id);
    for (const actor of [org.viewerA, org.approverA]) {
      expect(await codeOf(create("x", actor))).toBe("FORBIDDEN");
      expect(await codeOf(update(c.id, { status: "appealed" }, actor))).toBe("FORBIDDEN");
    }
    expect(await list({}, org.approverB)).toEqual([]);
    const stranger = await kit.makeOrg();
    expect(await list({}, stranger.owner)).toEqual([]);
    expect(await codeOf(update(c.id, { status: "appealed" }, stranger.owner))).toBe("NOT_FOUND");
    expect(await codeOf(create("x", stranger.owner))).toBe("NOT_FOUND");
  });
});
