import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, gte, lte } from "drizzle-orm";
import { createDb, reviewLinkClicks, reviewRequestRecipients, workspaceReplySettings, workspaces } from "@opengmb/db";
import { actions } from "./actions";
import { setEmailSender, type EmailMessage } from "./email";
import { MockGoogleClient } from "./google/mock-client";
import { openReviewRequestLink, unsubscribeInfo, unsubscribeReviewRequest } from "./review-requests/public";
import { sweepReviewRequests } from "./review-requests/sweep";
import { decideApproval, getWorkspaceReplySettings } from "./reviews/workspace-settings";
import { codeOf, makeKit, uniq, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());

const sent: EmailMessage[] = [];
const BASE = "https://app.example.test";
const PLACE = "ChIJ-test-place-id_1";
let savedBase: string | undefined;
beforeAll(() => {
  savedBase = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = BASE;
  setEmailSender(async (m) => void sent.push(m));
});
afterAll(async () => {
  setEmailSender(null);
  if (savedBase === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedBase;
  await kit.deactivateAll();
  await sql.end();
});

/** Each test works on its own calendar day so the server-wide 24 hour allowance never overlaps. */
const at = (day: number, hour = 10) => new Date(Date.UTC(2031, 0, day, hour));
const DAY = 86_400_000;
/** Legal batch B tests run in 2030, before every fixed 2031 day above, so server-wide counts of the older tests never see them. */
const at30 = (day: number, hour = 10) => new Date(Date.UTC(2030, 5, day, hour));

const IDENTITY = { legalName: "Whitfield Dental Pty Ltd", postalAddress: "12 George St, Sydney NSW 2000, Australia" };

async function setup(opts: { link?: boolean; tz?: string; identity?: boolean } = {}) {
  const org = await kit.makeOrg();
  const loc = await org.mkLoc(org.a);
  if (opts.link !== false) await kit.run(org.owner, "reviewLinks.save", { locationId: loc.row.id, placeId: PLACE });
  if (opts.identity !== false) await kit.run(org.owner, "workspaces.setSenderIdentity", { workspaceId: org.a, ...IDENTITY, companyNumber: "ABN 12 345 678 901" });
  if (opts.tz) await db.update(workspaces).set({ timeZone: opts.tz }).where(eq(workspaces.id, org.a));
  return { org, loc };
}
const mail = () => `${uniq()}@customer.test`;
const mkCampaign = async (org: Org, loc: Loc, extra: object = {}) =>
  (await kit.run<{ campaignId: string }>(org.owner, "reviewRequests.create", { locationId: loc.row.id, name: "Oct visits", ...extra })).campaignId;
const addOne = (org: Org, campaignId: string, email: string, name = "Dana Whitfield") =>
  kit.run<{ added: number }>(org.owner, "reviewRequests.addRecipients", { campaignId, recipients: [{ email, name }], listSource: "purchase", confirmPermission: true });
const start = (org: Org, campaignId: string) => kit.run(org.owner, "reviewRequests.start", { campaignId });
const sweep = (org: Org, now: Date, extra: object = {}) => sweepReviewRequests(db, { now, base: BASE, orgIds: [org.orgId], dailyLimit: 1000, ...extra });
const to = (email: string) => sent.filter((m) => m.to === email);
const tokenOf = async (email: string) => (await db.select().from(reviewRequestRecipients).where(eq(reviewRequestRecipients.email, email)))[0]!.linkToken;
type Results = { results: { recipients: number; sent: number; clicked: number; optedOut: number; reminderSent: number; skipped: number; failed: number; waiting: number } };

describe("campaign setup", () => {
  it("refuses a location without a review link (no place id)", async () => {
    const { org, loc } = await setup({ link: false });
    await expect(kit.run(org.owner, "reviewRequests.create", { locationId: loc.row.id, name: "x" })).rejects.toThrow(/no review link/);
  });

  it("CSV import needs the permission confirmation, cleans, dedupes and records counts without addresses", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const csv = 'Name,Email\n"Whitfield, Dana",DANA@x.test\nSam,sam@x.test\nSam,SAM@x.test\nbad,not-an-email\n';
    expect(await codeOf(kit.run(org.owner, "reviewRequests.importCsv", { campaignId: id, csv, listSource: "purchase" }))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "reviewRequests.importCsv", { campaignId: id, csv, listSource: "purchase", confirmPermission: false }))).toBe("INVALID_INPUT");
    const res = await kit.run(org.owner, "reviewRequests.importCsv", { campaignId: id, csv, listSource: "purchase", confirmPermission: true });
    expect(res).toEqual({ added: 2, duplicates: 1, invalid: 1, alreadyOptedOut: 0 });
    const rows = await kit.auditRows(org.orgId, "review_request.recipients_added");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('"permissionConfirmed":true');
    expect(JSON.stringify(rows[0])).not.toContain("x.test");
  });

  it("start is refused for rating or survey wording, for no recipients, and passes for the default text", async () => {
    const { org, loc } = await setup();
    const bad = await mkCampaign(org, loc, { body: "Hi {name}, how was your visit? Rate us 5 stars on Google." });
    await addOne(org, bad, mail());
    await expect(start(org, bad)).rejects.toThrow(/Cannot start/);
    const empty = await mkCampaign(org, loc);
    await expect(start(org, empty)).rejects.toThrow(/at least one customer/);
    const ok = await mkCampaign(org, loc);
    await addOne(org, ok, mail());
    expect(await start(org, ok)).toMatchObject({ ok: true, waiting: 1 });
    await expect(start(org, ok)).rejects.toThrow(/draft/);
  });

  it("start is refused when email sending is not configured", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    await addOne(org, id, mail());
    setEmailSender(async () => {}, false);
    try {
      expect(await codeOf(start(org, id))).toBe("NOT_CONFIGURED");
    } finally {
      setEmailSender(async (m) => void sent.push(m));
    }
  });
});

describe("sending, one reminder, clicks and opt-out (fixed clock, fake sender)", () => {
  it("sends once, reminds once after N days, and never a third time", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc, { reminderDays: 3 });
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    const r1 = await sweep(org, at(1));
    expect(r1).toMatchObject({ sent: 1, reminders: 0 });
    const first = to(email);
    expect(first).toHaveLength(1);
    const token = await tokenOf(email);
    // every recipient gets the same review path; the URL carries only the opaque token
    expect(first[0]!.html).toContain(`${BASE}/e/${token}`);
    expect(first[0]!.text).toContain(`${BASE}/e/${token}/unsubscribe`);
    expect(first[0]!.text).not.toContain(email);
    expect(first[0]!.headers?.["List-Unsubscribe"]).toBe(`<${BASE}/e/${token}/unsubscribe>`);
    expect(first[0]!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(first[0]!.idempotencyKey).toContain("initial");
    expect(first[0]!.text).toContain("You are receiving this from Whitfield Dental Pty Ltd (ABN 12 345 678 901) because you bought from");
    expect(first[0]!.text).toContain("12 George St, Sydney NSW 2000, Australia. Unsubscribe from");
    expect(first[0]!.text).toContain("OpenGMB is operated by Synectus Private Limited, 315 Radhe Square");

    expect(await sweep(org, at(1, 12))).toMatchObject({ sent: 0, reminders: 0 });
    expect(await sweep(org, new Date(at(1).getTime() + 3 * DAY - 60_000))).toMatchObject({ reminders: 0 });
    expect(await sweep(org, new Date(at(1).getTime() + 3 * DAY))).toMatchObject({ reminders: 1 });
    expect(to(email)).toHaveLength(2);
    expect(to(email)[1]!.subject.startsWith("Reminder: ")).toBe(true);
    expect(await sweep(org, at(20))).toMatchObject({ sent: 0, reminders: 0 });
    expect(to(email)).toHaveLength(2);

    const got = await kit.run<Results>(org.owner, "reviewRequests.get", { campaignId: id });
    expect(got.results).toMatchObject({ recipients: 1, sent: 1, reminderSent: 1, clicked: 0, optedOut: 0 });
  });

  it("a click is counted, returns the Google review URL, and cancels the reminder; a link scanner does neither", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const [clicker, scanned] = [mail(), mail()];
    await addOne(org, id, clicker);
    await addOne(org, id, scanned);
    await start(org, id);
    await sweep(org, at(2));
    const expected = `https://search.google.com/local/writereview?placeid=${PLACE}`;
    expect(await openReviewRequestLink(db, await tokenOf(scanned), { isBot: true, now: at(2, 11) })).toBe(expected);
    expect(await openReviewRequestLink(db, await tokenOf(clicker), { isBot: false, now: at(2, 11) })).toBe(expected);
    expect(await openReviewRequestLink(db, "A".repeat(43), { isBot: false })).toBeNull();
    expect(await openReviewRequestLink(db, "short", { isBot: false })).toBeNull();
    const r = await sweep(org, at(6));
    expect(r.reminders).toBe(1);
    expect(to(clicker)).toHaveLength(1);
    expect(to(scanned)).toHaveLength(2);
    const got = await kit.run<Results>(org.owner, "reviewRequests.get", { campaignId: id });
    expect(got.results).toMatchObject({ sent: 2, clicked: 1, reminderSent: 1 });
    const clicks = await db.select().from(reviewLinkClicks).where(eq(reviewLinkClicks.orgId, org.orgId));
    expect(clicks.filter((c) => c.source === "email").reduce((n, c) => n + c.count, 0)).toBe(1);
  });

  it("opting out stops the reminder, is idempotent, and the address is skipped in a new campaign", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    await sweep(org, at(8));
    const token = await tokenOf(email);
    expect(await unsubscribeInfo(db, token)).toMatchObject({ alreadyOptedOut: false });
    expect(await unsubscribeReviewRequest(db, token, at(8, 11))).toBe("ok");
    expect(await unsubscribeReviewRequest(db, token, at(8, 12))).toBe("ok");
    expect(await unsubscribeReviewRequest(db, "nope", at(8, 12))).toBe("invalid");
    expect(await sweep(org, at(12))).toMatchObject({ reminders: 0 });
    expect(to(email)).toHaveLength(1);
    const audit = await kit.auditRows(org.orgId, "review_request.opted_out");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(email);

    const second = await mkCampaign(org, loc);
    expect(await addOne(org, second, email.toUpperCase())).toMatchObject({ added: 0 });
    const keep = mail();
    await addOne(org, second, keep);
    await start(org, second);
    expect(await sweep(org, at(13))).toMatchObject({ sent: 1 });
    expect(to(email)).toHaveLength(1);
    expect(to(keep)).toHaveLength(1);
    const got = await kit.run<Results>(org.owner, "reviewRequests.get", { campaignId: second });
    expect(got.results).toMatchObject({ recipients: 2, sent: 1, skipped: 1, optedOut: 1 });
  });

  it("an opt-out that lands before the first send is honoured at send time", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    await unsubscribeReviewRequest(db, await tokenOf(email), at(14, 9));
    expect(await sweep(org, at(14))).toMatchObject({ sent: 0, skipped: 1 });
    expect(to(email)).toHaveLength(0);
  });

  it("sends nothing outside 08:00 to 21:00 in the client's time zone, then sends inside it", async () => {
    // 03:00 UTC is 22:00 the day before in Chicago (CDT/CST), 13:00 UTC is morning there
    const { org, loc } = await setup({ tz: "America/Chicago" });
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    expect(await sweep(org, at(16, 3))).toMatchObject({ sent: 0, outsideHours: 1 });
    expect(await sweep(org, at(16, 12))).toMatchObject({ sent: 0, outsideHours: 1 }); // 06:00 Chicago
    expect(await sweep(org, at(16, 15))).toMatchObject({ sent: 1 }); // 09:00 Chicago
    expect(to(email)).toHaveLength(1);
  });

  it("stops at the daily allowance and carries on the next day", async () => {
    // The allowance counts the whole server: clear sends left by earlier runs on these fixed days.
    await db.delete(reviewRequestRecipients).where(and(gte(reviewRequestRecipients.sentAt, at(17, 0)), lte(reviewRequestRecipients.sentAt, at(20, 0))));
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const emails = [mail(), mail(), mail()];
    for (const e of emails) await addOne(org, id, e);
    await start(org, id);
    expect(await sweep(org, at(18), { dailyLimit: 2 })).toMatchObject({ sent: 2 });
    expect(await sweep(org, at(18, 14), { dailyLimit: 2 })).toMatchObject({ sent: 0, blocked: "daily_limit" });
    expect(await sweep(org, at(19, 11), { dailyLimit: 2 })).toMatchObject({ sent: 1 });
    expect(emails.flatMap(to)).toHaveLength(3);
  });

  it("does nothing when the public URL is missing, and a cancelled campaign sends nothing", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    expect(await sweepReviewRequests(db, { now: at(21), base: null, orgIds: [org.orgId], send: async () => {} })).toMatchObject({ blocked: "no_base_url" });
    await kit.run(org.owner, "reviewRequests.cancel", { campaignId: id });
    expect(await sweep(org, at(21))).toMatchObject({ sent: 0 });
    expect(to(email)).toHaveLength(0);
  });

  it("a failing send is retried, then marked failed after three tries", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    await addOne(org, id, mail());
    await start(org, id);
    const boom = async () => {
      throw new Error("provider down");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const h of [10, 11, 12, 13]) await sweep(org, at(22, h), { send: boom });
    spy.mockRestore();
    const got = await kit.run<Results>(org.owner, "reviewRequests.get", { campaignId: id });
    expect(got.results).toMatchObject({ sent: 0, failed: 1 });
  });
});

describe("who can see what", () => {
  it("a client viewer sees results (counts) but not the customer list or the create button; another client sees nothing", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    await addOne(org, id, mail());
    const list = await kit.run<{ campaigns: { id: string }[] }>(org.viewerA, "reviewRequests.list", {});
    expect(list.campaigns.map((c) => c.id)).toContain(id);
    expect(JSON.stringify(list)).not.toContain("customer.test");
    expect(await codeOf(kit.run(org.viewerA, "reviewRequests.recipients", { campaignId: id }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.approverA, "reviewRequests.create", { locationId: loc.row.id, name: "x" }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.approverB, "reviewRequests.get", { campaignId: id }))).toMatch(/NOT_FOUND|FORBIDDEN/);
    const mgr = await kit.run<{ total: number }>(org.manager, "reviewRequests.recipients", { campaignId: id });
    expect(mgr.total).toBe(1);
  });
});

describe("legal batch B: sender identity, list source, healthcare, throttle", () => {
  it("start is refused without legal name and postal address (message links to the setting), then works once set", async () => {
    const { org, loc } = await setup({ identity: false });
    const id = await mkCampaign(org, loc);
    await addOne(org, id, mail());
    await expect(start(org, id)).rejects.toThrow(/legal name and postal address[\s\S]*\/settings\/workspace\?ws=/);
    await kit.run(org.owner, "workspaces.setSenderIdentity", { workspaceId: org.a, ...IDENTITY });
    await expect(start(org, id)).resolves.toMatchObject({ ok: true });
  });

  it("the sweep sends nothing for a client whose identity was removed, and sends once it is set", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    await db.update(workspaces).set({ senderPostalAddress: null }).where(eq(workspaces.id, org.a));
    expect(await sweep(org, at30(21))).toMatchObject({ sent: 0 });
    expect(to(email)).toHaveLength(0);
    await db.update(workspaces).set({ senderPostalAddress: IDENTITY.postalAddress }).where(eq(workspaces.id, org.a));
    expect(await sweep(org, at30(21, 11))).toMatchObject({ sent: 1 });
  });

  it("the footer leaves out the number when the business has none", async () => {
    const { org, loc } = await setup();
    await kit.run(org.owner, "workspaces.setSenderIdentity", { workspaceId: org.a, ...IDENTITY, phone: "+61 2 5550 0100" });
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    await sweep(org, at30(22));
    expect(to(email)[0]!.text).toContain("from Whitfield Dental Pty Ltd because you bought from");
    expect(to(email)[0]!.text).toContain("Australia \u00b7 +61 2 5550 0100.");
  });

  it("adding customers needs a list source, and stores the source, who confirmed and when", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    const base = { campaignId: id, recipients: [{ email }], confirmPermission: true };
    expect(await codeOf(kit.run(org.owner, "reviewRequests.addRecipients", base))).toBe("INVALID_INPUT");
    expect(await codeOf(kit.run(org.owner, "reviewRequests.addRecipients", { ...base, listSource: "bought-list" }))).toBe("INVALID_INPUT");
    await kit.run(org.owner, "reviewRequests.addRecipients", { ...base, listSource: "booking" });
    const [row] = await db.select().from(reviewRequestRecipients).where(eq(reviewRequestRecipients.email, email));
    expect(row).toMatchObject({ listSource: "booking", listConfirmedBy: org.ownerId });
    expect(row!.listConfirmedAt).toBeInstanceOf(Date);
  });

  it("a HIPAA covered entity cannot create, add or start review requests, and its campaigns are cancelled", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    await addOne(org, id, mail());
    await start(org, id);
    await kit.run(org.owner, "workspaces.setHipaa", { workspaceId: org.a, hipaaCoveredEntity: true });
    const got = await kit.run<{ status: string }>(org.owner, "reviewRequests.get", { campaignId: id });
    expect(got.status).toBe("cancelled");
    await expect(mkCampaign(org, loc)).rejects.toThrow(/HIPAA covered entity/);
    await expect(addOne(org, id, mail())).rejects.toThrow(/HIPAA covered entity/);
    await kit.run(org.owner, "workspaces.setHipaa", { workspaceId: org.a, hipaaCoveredEntity: false });
    await expect(mkCampaign(org, loc)).resolves.toBeTruthy();
  });

  it("setting HIPAA switches reply auto-approve off and keeps it locked, even if the stored row says otherwise", async () => {
    const { org } = await setup();
    const upd = (input: object) => kit.run<{ autoApproveMinStars: number | null; autoApproveLocked: boolean }>(org.owner, "workspaceSettings.update", { workspaceId: org.a, ...input });
    expect(await upd({ autoApproveMinStars: 4, autoPublish: true })).toMatchObject({ autoApproveMinStars: 4, autoApproveLocked: false });
    await kit.run(org.owner, "workspaces.setHipaa", { workspaceId: org.a, hipaaCoveredEntity: true });
    expect(await kit.run(org.owner, "workspaceSettings.get", { workspaceId: org.a })).toMatchObject({ autoApproveMinStars: null, autoPublish: false, autoApproveLocked: true });
    expect(await codeOf(upd({ autoApproveMinStars: 5 }))).toBe("INVALID_INPUT");
    expect(await codeOf(upd({ autoPublish: true }))).toBe("INVALID_INPUT");
    await expect(upd({ autoApproveMinStars: null, skipPositiveReviews: true })).resolves.toMatchObject({ autoApproveLocked: true });
    await db.update(workspaceReplySettings).set({ autoApproveMinStars: 4, autoPublish: true }).where(eq(workspaceReplySettings.workspaceId, org.a));
    const s = await db.transaction((tx) => getWorkspaceReplySettings(tx, org.a));
    expect(s).toMatchObject({ autoApproveMinStars: null, autoPublish: false });
    expect(decideApproval(s, 5)).toEqual({ autoApprove: false, autoPublish: false });
  });

  it("the sweep skips a recipient of a campaign started before the client became a covered entity", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const email = mail();
    await addOne(org, id, email);
    await start(org, id);
    await db.update(workspaces).set({ hipaaCoveredEntity: true }).where(eq(workspaces.id, org.a));
    expect(await sweep(org, at30(23))).toMatchObject({ sent: 0, skipped: 1 });
    expect(to(email)).toHaveLength(0);
  });

  it("each client has its own daily allowance, spread over later days", async () => {
    const { org, loc } = await setup();
    const id = await mkCampaign(org, loc);
    const emails = [mail(), mail(), mail()];
    for (const e of emails) await addOne(org, id, e);
    await start(org, id);
    expect(await sweep(org, at30(24), { workspaceDailyLimit: 2 })).toMatchObject({ sent: 2 });
    expect(await sweep(org, at30(24, 14), { workspaceDailyLimit: 2 })).toMatchObject({ sent: 0 });
    expect(await sweep(org, at30(25, 11), { workspaceDailyLimit: 2 })).toMatchObject({ sent: 1 });
    expect(emails.flatMap(to)).toHaveLength(3);
  });

  it("there is no way to choose recipients by rating or sentiment: the inputs of every review request action name no such field", async () => {
    const mine = actions.filter((a) => a.name.startsWith("reviewRequests."));
    expect(mine.length).toBeGreaterThanOrEqual(8);
    for (const a of mine) expect(JSON.stringify(a.input.toJSONSchema()), a.name).not.toMatch(/rating|sentiment|stars|score/i);
  });
});
