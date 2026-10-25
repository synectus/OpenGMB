import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  memberships,
  organizations,
  pushSubscriptions,
  users,
  workspaces,
} from "@opengmb/db";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

import { notifyApprovalRequested, APPROVAL_REQUESTED_KIND } from "./approvals";
import {
  isAllowedPushEndpoint,
  pushConfig,
  pushToUsers,
  PUSH_KINDS,
  removePushSubscription,
  savePushSubscription,
} from "./push";
import { GEOGRID_BUDGET_EXCEEDED_KIND } from "./geogrid/budget-alert";
import { REVIEW_NEGATIVE_KIND } from "./reviews/negative-alert";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const VAPID = {
  VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:ops@example.test",
};
const endpoint = () => `https://fcm.googleapis.com/fcm/send/${uniq()}`;

async function world() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: `ws-${uniq()}` }).returning();
  const mk = async (role: "owner" | "client_approver", workspaceId: string | null) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role, workspaceId });
    return id;
  };
  return { orgId: org!.id, wsId: ws!.id, mk };
}
const keys = { p256dh: "p", auth: "a" };

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(VAPID)) vi.stubEnv(k, v);
});

describe("push configuration", () => {
  it("is null unless all three VAPID values are set", () => {
    expect(pushConfig({ ...VAPID })).not.toBeNull();
    for (const k of Object.keys(VAPID)) expect(pushConfig({ ...VAPID, [k]: "" })).toBeNull();
    expect(pushConfig({})).toBeNull();
  });
  it("pins the kind strings that push.ts repeats as literals", () => {
    expect(PUSH_KINDS).toContain(REVIEW_NEGATIVE_KIND);
    expect(PUSH_KINDS).toContain(APPROVAL_REQUESTED_KIND);
    expect(PUSH_KINDS).toContain("google.new_review");
    expect(PUSH_KINDS).toContain(GEOGRID_BUDGET_EXCEEDED_KIND);
  });
  it("accepts only https endpoints of the browsers' push services", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://localhost/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.test/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});

describe("subscribe and unsubscribe", () => {
  it("stores a device, replaces it on the same endpoint, and removes only the caller's", async () => {
    const w = await world();
    const a = await w.mk("owner", null);
    const b = await w.mk("owner", null);
    const ep = endpoint();
    await savePushSubscription(db, { userId: a, orgId: w.orgId }, { endpoint: ep, ...keys });
    await savePushSubscription(db, { userId: a, orgId: w.orgId }, { endpoint: ep, p256dh: "p2", auth: "a2" });
    let rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, ep));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe("p2");
    expect(await removePushSubscription(db, { userId: b }, ep)).toBe(0);
    expect(await removePushSubscription(db, { userId: a }, ep)).toBe(1);
    rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, ep));
    expect(rows).toHaveLength(0);
  });
});

describe("sending", () => {
  it("sends a new-review payload (location name only) to the stored device", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    const ep = endpoint();
    await savePushSubscription(db, { userId: u, orgId: w.orgId }, { endpoint: ep, ...keys });
    const sent = await pushToUsers(db, w.orgId, [u], {
      kind: "google.new_review",
      title: "New review at Houston Clinic",
      link: null,
    });
    expect(sent).toBe(1);
    const [sub, body, opts] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual({ endpoint: ep, keys });
    expect(JSON.parse(body as string)).toEqual({
      title: "New review at Houston Clinic",
      url: "/reviews",
      tag: "google.new_review",
    });
    expect(opts).toMatchObject({ vapidDetails: { subject: VAPID.VAPID_SUBJECT, publicKey: "pub", privateKey: "priv" } });
  });

  it("sends an approval payload when something waits for approval", async () => {
    const w = await world();
    const approver = await w.mk("client_approver", w.wsId);
    const ep = endpoint();
    await savePushSubscription(db, { userId: approver, orgId: w.orgId }, { endpoint: ep, ...keys });
    const itemId = crypto.randomUUID();
    await db.transaction((tx) =>
      notifyApprovalRequested(tx, async () => {}, {
        orgId: w.orgId,
        workspaceId: w.wsId,
        type: "changeset",
        id: itemId,
        submittedAt: new Date(),
      }),
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendNotification.mock.calls[0]![1] as string);
    expect(payload.tag).toBe(APPROVAL_REQUESTED_KIND);
    expect(payload.url).toBe(`/portal/approvals/changeset/${itemId}`);
    expect(payload.title).toMatch(/awaiting your approval/);
  });

  it("does not push to people without a stored device or in another org", async () => {
    const w = await world();
    const other = await world();
    const u = await w.mk("owner", null);
    const o = await other.mk("owner", null);
    await savePushSubscription(db, { userId: o, orgId: other.orgId }, { endpoint: endpoint(), ...keys });
    const n = { kind: "google.new_review", title: "t", link: null };
    expect(await pushToUsers(db, w.orgId, [u], n)).toBe(0);
    expect(await pushToUsers(db, w.orgId, [o], n)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends nothing for kinds that are not new reviews or approvals", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    await savePushSubscription(db, { userId: u, orgId: w.orgId }, { endpoint: endpoint(), ...keys });
    expect(await pushToUsers(db, w.orgId, [u], { kind: "google.updated_review", title: "t", link: null })).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("is a silent no-op when VAPID is not configured", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    await savePushSubscription(db, { userId: u, orgId: w.orgId }, { endpoint: endpoint(), ...keys });
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(await pushToUsers(db, w.orgId, [u], { kind: "google.new_review", title: "t", link: null })).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("removes a subscription the push service reports as gone (404 and 410), keeps one that merely failed", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    const eps = { gone410: endpoint(), gone404: endpoint(), flaky: endpoint(), ok: endpoint() };
    for (const ep of Object.values(eps)) {
      await savePushSubscription(db, { userId: u, orgId: w.orgId }, { endpoint: ep, ...keys });
    }
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === eps.gone410) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (sub.endpoint === eps.gone404) throw Object.assign(new Error("nf"), { statusCode: 404 });
      if (sub.endpoint === eps.flaky) throw Object.assign(new Error("boom"), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent = await pushToUsers(db, w.orgId, [u], { kind: "google.new_review", title: "t", link: null });
    expect(sent).toBe(1);
    const left = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, u))).map((r) => r.endpoint);
    expect(left.sort()).toEqual([eps.flaky, eps.ok].sort());
    expect(warn.mock.calls.flat().join(" ")).not.toContain("fcm.googleapis.com");
    warn.mockRestore();
  });
});
