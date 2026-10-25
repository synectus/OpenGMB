import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gte, like, lt } from "drizzle-orm";
import { createDb, googleIdempotencyKeys, googleRateWindows, organizations } from "@opengmb/db";
import { CoreError } from "../errors";
import { GoogleApiError, GoogleRateLimitError, GoogleRetriesExhaustedError } from "./errors";
import { createGoogleClient } from "./factory";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { ReadOnlyGoogleClient } from "./read-only-client";
import { ThrottledGoogleClient } from "./throttled-client";
import { PROJECT_BUCKET, PostgresRateLimiter, useProjectBucketForTests } from "./throttler";

// This file asserts on the shared "project" bucket (fake-clock windows only), not the per-file test bucket.
useProjectBucketForTests(PROJECT_BUCKET);

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
const second = createDb(url); // a second connection pool stands in for a second process
afterAll(async () => {
  await client.end();
  await second.sql.end();
});

const WINDOW = 60_000;
const T0 = Math.floor(Date.UTC(2031, 0, 1) / WINDOW) * WINDOW; // window-aligned, far from real now
// This file owns [T0, T_END). Other files (profile.test.ts uses 2035) and real-time calls must not
// be touched by its setup, and its cleanup test uses a clock in the past (see below).
const T_END = Date.UTC(2032, 0, 1);
const mine = and(
  gte(googleRateWindows.windowStart, new Date(T0)),
  lt(googleRateWindows.windowStart, new Date(T_END)),
);

/** Fake time: sleep advances the clock instantly and is recorded. */
function fakeClock(start = T0 + 10_000, random = () => 0.5) {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
    },
    random,
  };
  return c;
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function makeOrg() {
  const [o] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  return o!.id;
}
// Only the fake-clock windows (2031): other test files make real-time throttled calls that write
// "project" rows for the current window, concurrently.
const windows = (bucket: string) =>
  db
    .select()
    .from(googleRateWindows)
    .where(and(eq(googleRateWindows.bucketKey, bucket), mine));

beforeEach(async () => {
  // Only this file's fake-clock windows: a global delete would wipe other files' throttle state.
  await db.delete(googleRateWindows).where(and(eq(googleRateWindows.bucketKey, "project"), mine));
  await db
    .delete(googleRateWindows)
    .where(and(like(googleRateWindows.bucketKey, "location-edit:%"), mine));
});
afterEach(() => vi.unstubAllEnvs());

function build(mock = new MockGoogleClient(), clock = fakeClock()) {
  return { mock, clock, g: new ThrottledGoogleClient(mock, db, clock) };
}
const names = async (mock: MockGoogleClient) =>
  (await mock.listLocations("accounts/100000000000000000001")).locations.map((l) => l.name);

describe("throttler: shared Postgres windows", () => {
  it("the 301st call in a window waits for the next window", async () => {
    const { mock, clock, g } = build();
    for (let i = 0; i < 300; i++) await g.listAccounts();
    expect(clock.sleeps).toEqual([]);
    const before = mock.callCount;
    await g.listAccounts();
    expect(clock.sleeps).toEqual([50_000 + 125]); // to T0+60s, plus jitter floor(0.5*250)
    expect(mock.callCount).toBe(before + 1);
    const rows = (await windows("project")).sort((a, b) => +a.windowStart - +b.windowStart);
    expect(rows.map((r) => [+r.windowStart, r.count])).toEqual([
      [T0, 300],
      [T0 + WINDOW, 1],
    ]);
  }, 60_000);

  it("review reads (list, get) take one project slot each and no idempotency key", async () => {
    const { mock, g } = build();
    const L = "locations/200000000000000001";
    const page = await g.listReviews("accounts/100000000000000000001", L, { pageSize: 3 });
    await g.getReview(page.reviews[0]!.name);
    expect((await windows("project")).map((r) => r.count)).toEqual([2]);
    expect(await windows(`location-edit:${L}`)).toHaveLength(0);
    expect(mock.calls.map((c) => c.method)).toEqual(["listReviews", "getReview"]);
  });

  it("the 11th edit to one location waits; an edit to another location does not", async () => {
    const { mock, clock, g } = build();
    const org = await makeOrg();
    const [a, b] = (await names(mock)) as [string, string];
    for (let i = 0; i < 10; i++) {
      await g.updateLocation(a, { title: `t${i}` }, ["title"], {
        orgId: org,
        idempotencyKey: `k${i}-${uniq()}`,
      });
    }
    expect(clock.sleeps).toEqual([]);
    await g.updateLocation(b, { title: "other" }, ["title"], {
      orgId: org,
      idempotencyKey: `o-${uniq()}`,
    });
    expect(clock.sleeps).toEqual([]);
    await g.updateLocation(a, { title: "t10" }, ["title"], {
      orgId: org,
      idempotencyKey: `k10-${uniq()}`,
    });
    expect(clock.sleeps).toEqual([50_000 + 125]);
    const rows = await windows(`location-edit:${a}`);
    expect(rows.map((r) => [+r.windowStart, r.count]).sort()).toEqual(
      [
        [T0, 10],
        [T0 + WINDOW, 1],
      ].sort(),
    );
    expect(await windows(`location-edit:${b}`)).toHaveLength(1);
  });

  it("two independent limiters sharing the DB never exceed the limit under concurrency", async () => {
    const bucket = `location-edit:test-${uniq()}`;
    const clock = fakeClock(T0 + 1_000);
    const l1 = new PostgresRateLimiter(db, clock);
    const l2 = new PostgresRateLimiter(second.db, clock);
    const limit = 25;
    const total = 70;
    await Promise.all(
      Array.from({ length: total }, (_, i) => (i % 2 ? l1 : l2).acquire(bucket, limit, WINDOW)),
    );
    const rows = await windows(bucket);
    expect(Math.max(...rows.map((r) => r.count))).toBeLessThanOrEqual(limit);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(total);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    console.log(
      `concurrent acquires: ${total} over ${rows.length} windows, max ${Math.max(...rows.map((r) => r.count))}/${limit}`,
    );
  });

  it("opportunistically deletes windows older than an hour", async () => {
    const bucket = `location-edit:test-${uniq()}`;
    // Cleanup deletes every bucket's windows older than now-1h. 2033 sits between this file's
    // 2031 range and profile.test.ts's 2035: far enough ahead that real-time cleanups elsewhere
    // (which only reach windows before today) cannot delete these rows, and it cannot reach 2035.
    const P0 = Math.floor(Date.UTC(2033, 0, 1) / WINDOW) * WINDOW;
    const old = new Date(P0 - 2 * 3600_000);
    await db.insert(googleRateWindows).values({ bucketKey: bucket, windowStart: old, count: 3 });
    const lim = new PostgresRateLimiter(
      db,
      fakeClock(P0 + 1000, () => 0),
    ); // random 0 => cleanup runs
    await lim.acquire(bucket, 5, WINDOW);
    const rows = await db
      .select()
      .from(googleRateWindows)
      .where(eq(googleRateWindows.bucketKey, bucket));
    expect(rows.map((r) => +r.windowStart)).toEqual([P0]);
    await db.delete(googleRateWindows).where(eq(googleRateWindows.bucketKey, bucket));
  });
});

describe("throttled client: retries", () => {
  it("429 x3 then success: 4 calls, exponential sleeps", async () => {
    const { mock, clock, g } = build();
    mock.rateLimitNext(3);
    await g.listAccounts();
    expect(mock.callCount).toBe(4);
    expect(clock.sleeps).toEqual([500, 1000, 2000]); // full jitter at random=0.5 of 1s, 2s, 4s
  });

  it("honours Retry-After when larger than the backoff, ignores it when smaller", async () => {
    const { mock, clock, g } = build();
    mock.rateLimitNext(1, 30);
    mock.rateLimitNext(1, 0);
    await g.listAccounts();
    expect(clock.sleeps).toEqual([30_000, 1000]);
  });

  it("backoff is capped at 60s", async () => {
    const { mock, clock, g } = build(
      new MockGoogleClient(),
      fakeClock(T0 + 1000, () => 0.999999),
    );
    mock.rateLimitNext(5);
    await g.listAccounts();
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(60_000);
    expect(clock.sleeps).toHaveLength(5);
    expect(clock.sleeps[4]).toBeGreaterThan(15_000);
  });

  it("429 beyond max retries throws a typed error after 6 attempts", async () => {
    const { mock, g } = build();
    mock.rateLimitNext(100);
    const e = await g.listAccounts().catch((x) => x);
    expect(e).toBeInstanceOf(GoogleRetriesExhaustedError);
    expect(e.attempts).toBe(6);
    expect(e.cause).toBeInstanceOf(GoogleRateLimitError);
    expect(mock.callCount).toBe(6);
  });

  it("400 is not retried", async () => {
    const { mock, clock, g } = build();
    mock.failNext(1, () => new GoogleApiError(400, { error: {} }));
    await expect(g.listAccounts()).rejects.toMatchObject({ status: 400 });
    expect(mock.callCount).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("5xx retries at most twice, then rethrows; a recovery in between succeeds", async () => {
    const a = build();
    a.mock.failNext(10, () => new GoogleApiError(503, null));
    await expect(a.g.listAccounts()).rejects.toMatchObject({ status: 503 });
    expect(a.mock.callCount).toBe(3);
    expect(a.clock.sleeps).toEqual([500, 1000]);
    const b = build();
    b.mock.failNext(2, () => new GoogleApiError(500, null));
    await expect(b.g.listAccounts()).resolves.toBeTruthy();
    expect(b.mock.callCount).toBe(3);
  });

  it("each retry takes quota again", async () => {
    const { mock, g } = build();
    mock.rateLimitNext(2);
    await g.listAccounts();
    expect((await windows("project"))[0]!.count).toBe(3);
  });
});

describe("throttled client: idempotent writes", () => {
  const patch = { title: "Idem" };
  const mask = ["title"];

  it("same key + same payload: one Google call, same response", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const [loc] = await names(mock);
    const ctx = { orgId: org, idempotencyKey: `k-${uniq()}` };
    const r1 = await g.updateLocation(loc!, patch, mask, ctx);
    const r2 = await g.updateLocation(loc!, { ...patch }, [...mask], ctx);
    expect(mock.calls.filter((c) => c.method === "updateLocation")).toHaveLength(1);
    expect(r2).toEqual(r1);
    const [row] = await db
      .select()
      .from(googleIdempotencyKeys)
      .where(eq(googleIdempotencyKeys.orgId, org));
    expect(row).toMatchObject({ status: "done", key: ctx.idempotencyKey });
    expect(row!.response).toEqual(r1);
  });

  it("reply writes take project quota only (no location-edit bucket) and are idempotent", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const page = await g.listReviews(
      "accounts/100000000000000000001",
      "locations/200000000000000001",
      {
        pageSize: 1,
      },
    );
    const name = page.reviews[0]!.name;
    const ctx = { orgId: org, idempotencyKey: `reply:${uniq()}` };
    const r1 = await g.updateReply(name, "Thanks", ctx);
    expect(await g.updateReply(name, "Thanks", ctx)).toEqual(r1);
    expect(mock.calls.filter((c) => c.method === "updateReply")).toHaveLength(1);
    await expect(g.updateReply(name, "Different", ctx)).rejects.toMatchObject({ code: "CONFLICT" });
    const del = { orgId: org, idempotencyKey: `delete:${uniq()}` };
    await g.deleteReply(name, del);
    await g.deleteReply(name, del);
    expect(mock.calls.filter((c) => c.method === "deleteReply")).toHaveLength(1);
    // listReviews + one updateReply + one deleteReply reached Google: 3 project slots, no edit bucket
    expect((await windows("project")).map((r) => r.count)).toEqual([3]);
    expect(
      await db
        .select()
        .from(googleRateWindows)
        .where(and(like(googleRateWindows.bucketKey, "location-edit:%"), mine)),
    ).toHaveLength(0);
  });

  it("canonical hash: key order in the patch does not matter", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const [loc] = await names(mock);
    const ctx = { orgId: org, idempotencyKey: `k-${uniq()}` };
    await g.updateLocation(
      loc!,
      { title: "A", websiteUri: "https://a.example" },
      ["title", "websiteUri"],
      ctx,
    );
    await g.updateLocation(
      loc!,
      { websiteUri: "https://a.example", title: "A" },
      ["title", "websiteUri"],
      ctx,
    );
    expect(mock.calls.filter((c) => c.method === "updateLocation")).toHaveLength(1);
  });

  it("same key + different payload: CONFLICT, no second call", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const [loc] = await names(mock);
    const ctx = { orgId: org, idempotencyKey: `k-${uniq()}` };
    await g.updateLocation(loc!, patch, mask, ctx);
    const e = await g.updateLocation(loc!, { title: "Different" }, mask, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(CoreError);
    expect(e.code).toBe("CONFLICT");
    expect(mock.calls.filter((c) => c.method === "updateLocation")).toHaveLength(1);
  });

  it("keys are scoped per org", async () => {
    const { mock, g } = build();
    const [o1, o2] = [await makeOrg(), await makeOrg()];
    const [loc] = await names(mock);
    const key = `k-${uniq()}`;
    await g.updateLocation(loc!, patch, mask, { orgId: o1, idempotencyKey: key });
    await g.updateLocation(loc!, patch, mask, { orgId: o2, idempotencyKey: key });
    expect(mock.calls.filter((c) => c.method === "updateLocation")).toHaveLength(2);
  });

  it("a key still pending is CONFLICT (in progress)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    class Gated extends MockGoogleClient {
      override async updateLocation(...a: Parameters<MockGoogleClient["updateLocation"]>) {
        const p = super.updateLocation(...a);
        if (!gated) {
          gated = true;
          await gate;
        }
        return p;
      }
    }
    const mock = new Gated();
    const { g } = build(mock);
    const org = await makeOrg();
    const [loc] = await names(mock);
    const ctx = { orgId: org, idempotencyKey: `k-${uniq()}` };
    const first = g.updateLocation(loc!, patch, mask, ctx);
    await vi.waitFor(() =>
      expect(mock.calls.some((c) => c.method === "updateLocation")).toBe(true),
    );
    const e = await g.updateLocation(loc!, patch, mask, ctx).catch((x) => x);
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toMatch(/in progress/);
    release();
    await first;
    await expect(g.updateLocation(loc!, patch, mask, ctx)).resolves.toMatchObject({
      title: "Idem",
    });
  });

  it("a Google failure removes the pending row so the same key can be retried", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const [loc] = await names(mock);
    const ctx = { orgId: org, idempotencyKey: `k-${uniq()}` };
    mock.failNext(1, () => new GoogleApiError(400, null));
    await expect(g.updateLocation(loc!, patch, mask, ctx)).rejects.toMatchObject({ status: 400 });
    expect(
      await db.select().from(googleIdempotencyKeys).where(eq(googleIdempotencyKeys.orgId, org)),
    ).toHaveLength(0);
    await expect(g.updateLocation(loc!, patch, mask, ctx)).resolves.toMatchObject({
      title: "Idem",
    });
    const [row] = await db
      .select()
      .from(googleIdempotencyKeys)
      .where(eq(googleIdempotencyKeys.orgId, org));
    expect(row!.status).toBe("done");
  });

  it("exhausted 429 retries also release the key", async () => {
    const { mock, g } = build();
    const org = await makeOrg();
    const [loc] = await names(mock);
    mock.rateLimitNext(100);
    await expect(
      g.updateLocation(loc!, patch, mask, { orgId: org, idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(GoogleRetriesExhaustedError);
    expect(
      await db.select().from(googleIdempotencyKeys).where(eq(googleIdempotencyKeys.orgId, org)),
    ).toHaveLength(0);
  });
});

describe("createGoogleClient", () => {
  const connection = { refreshTokenEnc: "unused-in-mock-mode" };

  it("defaults to the mock, also for empty/mock env", () => {
    vi.stubEnv("GOOGLE_BUSINESS_API_MODE", "");
    expect(createGoogleClient({ db, connection }).inner).toBeInstanceOf(MockGoogleClient);
    vi.stubEnv("GOOGLE_BUSINESS_API_MODE", "mock");
    const c = createGoogleClient({ db, connection });
    expect(c).toBeInstanceOf(ThrottledGoogleClient);
    expect(c.inner).toBeInstanceOf(MockGoogleClient);
  });

  it("builds the live client only for GOOGLE_BUSINESS_API_MODE=live (construction makes no request)", () => {
    vi.stubEnv("GOOGLE_BUSINESS_API_MODE", "live");
    vi.stubEnv("GOOGLE_BUSINESS_WRITES", "live");
    const c = createGoogleClient({ db, connection });
    expect(c.inner).toBeInstanceOf(LiveGoogleClient);
  });

  it("live mode is read-only unless GOOGLE_BUSINESS_WRITES=live", () => {
    vi.stubEnv("GOOGLE_BUSINESS_API_MODE", "live");
    for (const v of ["", "off"]) {
      vi.stubEnv("GOOGLE_BUSINESS_WRITES", v);
      const c = createGoogleClient({ db, connection });
      expect(c.inner).toBeInstanceOf(ReadOnlyGoogleClient);
      expect((c.inner as ReadOnlyGoogleClient).inner).toBeInstanceOf(LiveGoogleClient);
    }
    vi.stubEnv("GOOGLE_BUSINESS_WRITES", "yes");
    expect(() => createGoogleClient({ db, connection })).toThrow(/GOOGLE_BUSINESS_WRITES/);
  });

  it("fails closed on an unknown mode", () => {
    vi.stubEnv("GOOGLE_BUSINESS_API_MODE", "prod");
    expect(() => createGoogleClient({ db, connection })).toThrow(/GOOGLE_BUSINESS_API_MODE/);
  });
});
