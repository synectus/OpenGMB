import { describe, expect, it } from "vitest";
import { liveStatus, liveStatusForViewer } from "./live-status";

const LIVE_ENV = {
  GOOGLE_BUSINESS_API_MODE: "live",
  GOOGLE_BUSINESS_WRITES: "live",
  PUBSUB_TOPIC: "projects/example-project/topics/opengmb-reviews",
  PUBSUB_AUDIENCE: "https://app.example/webhooks/google-pubsub",
  PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.iam.gserviceaccount.com",
};

const NOW = new Date("2026-10-25T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const FLOWING = { registered: 2, lastPushAt: day(1), recentDays: 30, now: NOW };

describe("liveStatus", () => {
  it("lists five areas (denominator)", () => {
    expect(liveStatus({}, false).rows.map((r) => r.key)).toEqual([
      "google",
      "writes",
      "pubsub",
      "rank",
      "email",
    ]);
  });

  it("defaults to the simulator, like core's client factory", () => {
    const s = liveStatus({}, false);
    expect(s.rows[0]!.state).toBe("simulated");
    // Rank tracking is sample data, which is not counted as a part that is not live.
    expect(s.notLive).toBe(4);
    expect(s.banner).toMatch(/simulated/i);
  });

  it("live reads with writes unset means writes are off, with a banner", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: "live" }, true);
    expect(s.rows.find((r) => r.key === "writes")!.state).toBe("off");
    expect(s.banner).toMatch(/writes are off/i);
  });

  it("canary: rank tracking is sample data without DataForSEO keys, and not counted as not live", () => {
    const s = liveStatus(LIVE_ENV, true, FLOWING);
    expect(s.rows.find((r) => r.key === "rank")!.state).toBe("sample");
    expect(s.notLive).toBe(0);
    expect(s.banner).toBeNull();
  });

  it("rank tracking is live with both DataForSEO keys, sample with half a key or the sandbox", () => {
    const keys = { DATAFORSEO_LOGIN: "l@example.test", DATAFORSEO_PASSWORD: "p" };
    const rank = (env: Record<string, string>) => liveStatus({ ...LIVE_ENV, ...env }, true, FLOWING).rows.find((r) => r.key === "rank")!;
    expect(rank(keys)).toMatchObject({ state: "live", detail: "Heatmaps come from DataForSEO Google Maps." });
    expect(rank({ DATAFORSEO_LOGIN: "l@example.test" }).state).toBe("sample");
    expect(rank({ ...keys, DATAFORSEO_API_BASE: "https://sandbox.dataforseo.com" }).state).toBe("sample");
    expect(rank({ ...keys, DATAFORSEO_API_BASE: "https://api.dataforseo.com" }).state).toBe("live");
    expect(rank(keys).detail).not.toContain("l@example.test");
  });

  it("counts every state except live and sample data (this server: 3 parts not live)", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: "live" }, false);
    expect(s.rows.map((r) => r.state)).toEqual(["live", "off", "not_set_up", "sample", "not_set_up"]);
    expect(s.notLive).toBe(3);
  });

  it("names the setting for each row that has one", () => {
    const s = liveStatus({}, false);
    expect(s.rows.find((r) => r.key === "writes")!.setting).toBe("GOOGLE_BUSINESS_WRITES");
    expect(s.rows.find((r) => r.key === "rank")!.setting).toBeNull();
  });

  it("an unknown API mode is misconfigured, not simulated", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: "Live" }, false);
    expect(s.rows.find((r) => r.key === "google")!.state).toBe("misconfigured");
    expect(s.banner).toMatch(/unrecognised value/i);
  });

  it("an unknown writes value in live mode is misconfigured", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "true" }, false);
    expect(s.rows.find((r) => r.key === "writes")!.state).toBe("misconfigured");
    expect(s.banner).toMatch(/unrecognised value/i);
  });

  it("trims whitespace like core does", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: " live ", GOOGLE_BUSINESS_WRITES: " live " }, false);
    expect(s.rows.find((r) => r.key === "google")!.state).toBe("live");
    expect(s.rows.find((r) => r.key === "writes")!.state).toBe("live");
  });

  it("mock mode with writes live is simulated", () => {
    const s = liveStatus({ GOOGLE_BUSINESS_API_MODE: "mock", GOOGLE_BUSINESS_WRITES: "live" }, false);
    expect(s.rows.find((r) => r.key === "writes")!.state).toBe("simulated");
  });
});

describe("Instant review alerts row", () => {
  const row = (env: Record<string, string>, push?: Parameters<typeof liveStatus>[2]) =>
    liveStatus(env, true, push).rows.find((r) => r.key === "pubsub")!;
  const { PUBSUB_TOPIC, PUBSUB_AUDIENCE, PUBSUB_SERVICE_ACCOUNT_EMAIL } = LIVE_ENV;

  it("canary: all three settings, a registered account and a recent push read Live", () => {
    expect(row(LIVE_ENV, FLOWING).state).toBe("live");
  });

  it("each of the three settings is needed (denominator: 3 omissions, all Not set up)", () => {
    const omissions: Record<string, string>[] = [
      { PUBSUB_AUDIENCE, PUBSUB_SERVICE_ACCOUNT_EMAIL },
      { PUBSUB_TOPIC, PUBSUB_SERVICE_ACCOUNT_EMAIL },
      { PUBSUB_TOPIC, PUBSUB_AUDIENCE },
    ];
    expect(omissions).toHaveLength(3);
    for (const env of omissions) expect(row(env, FLOWING).state, JSON.stringify(Object.keys(env))).toBe("not_set_up");
  });

  it("settings without a registered account, or without database facts, are not Live", () => {
    expect(row(LIVE_ENV, { ...FLOWING, registered: 0 }).state).toBe("not_set_up");
    expect(row(LIVE_ENV).state).toBe("not_set_up");
    expect(row(LIVE_ENV, { ...FLOWING, registered: 0 }).detail).toMatch(/no Google account is registered/i);
  });

  it("registered but never pushed reads Waiting for first notification", () => {
    const r = row(LIVE_ENV, { ...FLOWING, lastPushAt: null });
    expect(r.state).toBe("off");
    expect(r.detail).toMatch(/waiting for first notification/i);
  });

  it("a push older than the window is not Live; one inside it is", () => {
    expect(row(LIVE_ENV, { ...FLOWING, lastPushAt: day(31) }).state).toBe("off");
    expect(row(LIVE_ENV, { ...FLOWING, lastPushAt: day(29) }).state).toBe("live");
  });
});

describe("liveStatusForViewer", () => {
  const status = liveStatus({}, false);

  it("gives a platform admin the rows with their setting names", () => {
    const seen = liveStatusForViewer(status, true);
    expect(seen?.rows.map((r) => r.setting)).toContain("GOOGLE_BUSINESS_API_MODE");
    expect(seen?.notLive).toBeGreaterThan(0);
  });

  it("gives everyone else nothing: no rows, no setting names, no count", () => {
    expect(liveStatusForViewer(status, false)).toBeNull();
  });
});
