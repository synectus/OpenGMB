import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import {
  createDb,
  googleConnections,
  googleNotificationRegistrations,
  organizations,
  users,
} from "@opengmb/db";
import { GOOGLE_NOTIFICATIONS } from "./config/google-notifications";
import { encryptSecret } from "./crypto";
import { CoreError } from "./errors";
import { GoogleApiError } from "./google/errors";
import { LiveGoogleClient } from "./google/live-client";
import { MockGoogleClient } from "./google/mock-client";
import { setSharedMockGoogleClient } from "./google/factory";
import {
  registerAccount,
  registerConnectionNotifications,
  registrationErrorMessage,
  runNotificationRegistration,
} from "./google/notification-registration";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TOPIC = "projects/example-project/topics/opengmb-reviews";
// Unique per run: the test database is shared and account_name is unique.
const ACCT = `accounts/9${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ACCT2 = `${ACCT}9`;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("LiveGoogleClient notification settings (fake fetch)", () => {
  it("canary: update is PATCH v1/{account}/notificationSetting with updateMask and the topic and types", async () => {
    const seen: { url: URL; init: RequestInit }[] = [];
    const c = new LiveGoogleClient({
      getAccessToken: async () => "tok",
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: new URL(String(u)), init: init ?? {} });
        return json(200, { name: `${ACCT}/notificationSetting`, pubsubTopic: TOPIC });
      }) as typeof fetch,
    });
    await c.updateNotificationSetting(
      ACCT,
      { name: "ignored", pubsubTopic: TOPIC, notificationTypes: GOOGLE_NOTIFICATIONS.notificationTypes },
      GOOGLE_NOTIFICATIONS.updateMask,
    );
    await c.getNotificationSetting(ACCT);
    expect(seen).toHaveLength(2);
    const [patch, get] = seen;
    expect(patch!.init.method).toBe("PATCH");
    expect(patch!.url.origin + patch!.url.pathname).toBe(`https://mybusinessnotifications.googleapis.com/v1/${ACCT}/notificationSetting`);
    expect(patch!.url.searchParams.get("updateMask")).toBe("pubsubTopic,notificationTypes");
    expect((patch!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(patch!.init.body))).toEqual({
      name: `${ACCT}/notificationSetting`,
      pubsubTopic: TOPIC,
      notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW", "GOOGLE_UPDATE"],
    });
    expect(get!.init.method).toBe("GET");
  });

  it("refuses a name that is not accounts/{id}", async () => {
    const c = new LiveGoogleClient({ getAccessToken: async () => "tok", fetch: (async () => json(200, {})) as typeof fetch });
    await expect(c.getNotificationSetting("locations/1")).rejects.toBeInstanceOf(CoreError);
  });
});

describe("registerAccount", () => {
  it("writes once, then is a no-op while the topic and types match; a different topic writes again", async () => {
    const mock = new MockGoogleClient();
    expect(await registerAccount(mock, ACCT, TOPIC)).toBe("registered");
    expect(await registerAccount(mock, ACCT, TOPIC)).toBe("unchanged");
    expect(mock.calls.filter((c) => c.method === "updateNotificationSetting")).toHaveLength(1);
    expect(mock.calls.find((c) => c.method === "updateNotificationSetting")!.args).toEqual([
      ACCT,
      { name: `${ACCT}/notificationSetting`, pubsubTopic: TOPIC, notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW", "GOOGLE_UPDATE"] },
      "pubsubTopic,notificationTypes",
    ]);
    expect(await registerAccount(mock, ACCT, `${TOPIC}-2`)).toBe("registered");
    expect(mock.calls.filter((c) => c.method === "updateNotificationSetting")).toHaveLength(2);
  });
});

describe("registrationErrorMessage", () => {
  const disabled = new GoogleApiError(403, {
    error: { status: "PERMISSION_DENIED", message: "API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] },
  });
  it("403 SERVICE_DISABLED names the API to enable", () => {
    expect(registrationErrorMessage(disabled)).toContain(GOOGLE_NOTIFICATIONS.apiName);
    expect(registrationErrorMessage(disabled)).toMatch(/not enabled/);
  });
  it("other 403 and a bad topic get different plain messages", () => {
    expect(registrationErrorMessage(new GoogleApiError(403, { error: { message: "nope" } }))).toMatch(/refused/);
    expect(registrationErrorMessage(new GoogleApiError(400, { error: { message: "bad topic" } }))).toContain(GOOGLE_NOTIFICATIONS.publisherServiceAccount);
  });
});

describe("registerConnectionNotifications and the job", () => {
  let orgId: string;
  let connId: string;
  const conn = () => ({ id: connId, orgId, refreshTokenEnc: "unused" });
  const rows = () =>
    db.select().from(googleNotificationRegistrations).where(inArray(googleNotificationRegistrations.accountName, [ACCT, ACCT2]));

  beforeAll(async () => {
    const [o] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    orgId = o!.id;
    const uid = `u-${uniq()}`;
    await db.insert(users).values({ id: uid, name: "T", email: `n-${uniq()}@example.test`, emailVerified: true });
    const [c] = await db
      .insert(googleConnections)
      .values({ orgId, userId: uid, googleAccountId: `sub-${uniq()}`, googleAccountEmail: "g@example.test", refreshTokenEnc: encryptSecret("rt"), scopes: [] })
      .returning();
    connId = c!.id;
  });
  beforeEach(async () => {
    await db.delete(googleNotificationRegistrations).where(inArray(googleNotificationRegistrations.accountName, [ACCT, ACCT2]));
    vi.stubEnv("PUBSUB_TOPIC", TOPIC);
  });
  afterAll(() => vi.unstubAllEnvs());

  const fake = (accounts: string[], failFor: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      listAccounts: async () => ({ accounts: accounts.map((name) => ({ name }) as never) }),
      getNotificationSetting: async (n: string) => ({ name: `${n}/notificationSetting` }),
      updateNotificationSetting: async (n: string) => {
        calls.push(n);
        if (failFor[n]) throw failFor[n];
        return { name: `${n}/notificationSetting` };
      },
    };
  };

  it("records registered-at and topic per account; a second run changes nothing at Google", async () => {
    const mock = new MockGoogleClient();
    const first = await registerConnectionNotifications(db, conn(), "all", { client: Object.assign(mock, { listAccounts: async () => ({ accounts: [{ name: ACCT }, { name: ACCT2 }] as never }) }) });
    expect(first).toMatchObject({ accounts: 2, registered: 2, unchanged: 0, failed: 0 });
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.registeredAt && x.topic === TOPIC && x.lastError === null)).toBe(true);
    const second = await registerConnectionNotifications(db, conn(), "all", { client: mock });
    expect(second).toMatchObject({ registered: 0, unchanged: 2, failed: 0 });
    expect(mock.calls.filter((c) => c.method === "updateNotificationSetting")).toHaveLength(2);
  });

  it("one failing account records its error and does not stop the next; SERVICE_DISABLED names the API", async () => {
    const disabled = new GoogleApiError(403, { error: { message: "disabled", details: [{ reason: "SERVICE_DISABLED" }] } });
    const f = fake([ACCT, ACCT2], { [ACCT]: disabled });
    const s = await registerConnectionNotifications(db, conn(), "all", { client: f });
    expect(s).toMatchObject({ accounts: 2, registered: 1, failed: 1 });
    const byName = Object.fromEntries((await rows()).map((x) => [x.accountName, x]));
    expect(byName[ACCT]!.registeredAt).toBeNull();
    expect(byName[ACCT]!.lastError).toContain(GOOGLE_NOTIFICATIONS.apiName);
    expect(byName[ACCT2]!.registeredAt).not.toBeNull();
    // A later success clears the error and sets the time.
    const ok = fake([ACCT]);
    await registerConnectionNotifications(db, conn(), "all", { client: ok });
    const again = (await rows()).find((x) => x.accountName === ACCT)!;
    expect(again.lastError).toBeNull();
    expect(again.registeredAt).not.toBeNull();
  });

  it("the daily scope skips accounts nobody imported and has no registration row yet", async () => {
    const f = fake([ACCT, ACCT2]);
    const s = await registerConnectionNotifications(db, conn(), "relevant", { client: f });
    expect(s).toMatchObject({ accounts: 0, registered: 0 });
    expect(f.calls).toEqual([]);
  });

  it("without PUBSUB_TOPIC nothing is called and nothing recorded", async () => {
    vi.stubEnv("PUBSUB_TOPIC", "");
    const f = fake([ACCT]);
    const s = await registerConnectionNotifications(db, conn(), "all", { client: f });
    expect(s.skipped).toBe("no_topic");
    expect(f.calls).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  it("the job registers through the Google client factory (mock mode) for one connection", async () => {
    const mock = new MockGoogleClient();
    setSharedMockGoogleClient(mock);
    try {
      const s = await runNotificationRegistration(db, { connectionId: connId, scope: "all" });
      expect(s.failed).toBe(0);
      expect(s.registered).toBe(2); // the two fixture accounts
      expect(mock.calls.filter((c) => c.method === "updateNotificationSetting")).toHaveLength(2);
    } finally {
      setSharedMockGoogleClient(null);
      await db.delete(googleNotificationRegistrations).where(inArray(googleNotificationRegistrations.accountName, ["accounts/100000000000000000001", "accounts/100000000000000000002"]));
    }
  });
});
