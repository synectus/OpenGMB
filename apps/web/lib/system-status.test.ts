import { describe, expect, it } from "vitest";
import { liveStatus } from "./live-status";
import { makeTimeFormat } from "./time-format";
import {
  LIVE_STATE,
  jobResultText,
  lateText,
  notLiveSummary,
  reviewsCell,
  turnsOn,
} from "./system-status";

const utcTf = makeTimeFormat({ zones: [], workspaceId: null });
const istTf = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const live = { GOOGLE_BUSINESS_API_MODE: "live" };

describe("notLiveSummary", () => {
  it("canary: lists exactly the rows the pill counts (PR #2 rule)", () => {
    const s = liveStatus(live, false);
    expect(notLiveSummary(s)).toBe("3 parts not live: Publishing to Google, Instant review alerts, Email");
    const all = liveStatus(
      { ...live, GOOGLE_BUSINESS_WRITES: "live", PUBSUB_TOPIC: "t", PUBSUB_AUDIENCE: "a", PUBSUB_SERVICE_ACCOUNT_EMAIL: "b" },
      true,
      { registered: 1, lastPushAt: new Date(), recentDays: 30 },
    );
    expect(all.notLive).toBe(0);
    expect(notLiveSummary(all)).toBe("Everything is live");
  });

  it("every state has a badge (denominator 6)", () => {
    expect(Object.keys(LIVE_STATE).sort()).toEqual(
      ["live", "misconfigured", "not_set_up", "off", "sample", "simulated"],
    );
  });
});

describe("turnsOn", () => {
  const rows = (env: Record<string, string>, email = false) => liveStatus(env, email).rows;
  const row = (env: Record<string, string>, key: string) => rows(env).find((r) => r.key === key)!;

  it("names the setting only for owners and admins", () => {
    expect(turnsOn(row(live, "writes"), true)).toBe(
      "An owner sets GOOGLE_BUSINESS_WRITES to live for this server.",
    );
    expect(turnsOn(row(live, "writes"), false)).toBe("An owner turns publishing to Google on for this server.");
    expect(turnsOn(row(live, "google"), true)).toBe("Already on.");
  });

  it("covers misconfigured, simulated and the fixed rows", () => {
    expect(turnsOn(row({ ...live, GOOGLE_BUSINESS_WRITES: "on" }, "writes"), true)).toBe(
      "Set GOOGLE_BUSINESS_WRITES to a recognised value.",
    );
    expect(turnsOn(row({ ...live, GOOGLE_BUSINESS_WRITES: "on" }, "writes"), false)).toBe(
      "An owner fixes this setting for this server.",
    );
    expect(turnsOn(row({}, "google"), false)).toBe(
      "Google approves API access for the project, then an owner switches this server to live Google data.",
    );
    expect(turnsOn(row(live, "rank"), false)).toBe("A DataForSEO connection.");
    expect(turnsOn(row(live, "email"), false)).toBe("An email provider key and a sending address.");
    expect(turnsOn(row(live, "pubsub"), false)).toContain("organization policy exception");
  });
});

describe("job and location text", () => {
  it("result text", () => {
    expect(jobResultText({ result: "never", note: null })).toBe("No run recorded yet");
    expect(jobResultText({ result: "ok", note: null })).toBe("ok");
    expect(jobResultText({ result: "ok", note: "skipped: email not set up" })).toBe("skipped: email not set up");
    expect(jobResultText({ result: "failed", note: null })).toBe("failed");
  });

  it("late text names the job and the last run in the client's zone", () => {
    expect(lateText({ label: "Review sync", lastRunAt: "2026-10-18T06:15:00.000Z" }, utcTf)).toBe(
      "Review sync has not run since 2026-10-18 06:15. The worker may be down.",
    );
    expect(lateText({ label: "Review sync", lastRunAt: "2026-10-18T06:15:00.000Z" }, istTf)).toBe(
      "Review sync has not run since 18/10/2026 11:45. The worker may be down.",
    );
  });

  it("reviews cell: relink, inactive, pending, synced, never", () => {
    const base = { status: "active", needsRelink: false, reviewsLastStatus: null, reviewsLastSyncedAt: null, workspaceId: "w" };
    expect(reviewsCell({ ...base, needsRelink: true }, utcTf)).toBe("Not linked to Google");
    expect(reviewsCell({ ...base, status: "inactive" }, utcTf)).toBe("Inactive, not synced");
    expect(reviewsCell({ ...base, reviewsLastStatus: "pending" }, utcTf)).toBe("Waiting for the worker");
    expect(reviewsCell({ ...base, reviewsLastSyncedAt: "2026-10-18T10:15:00.000Z" }, utcTf)).toBe("2026-10-18 10:15");
    expect(reviewsCell({ ...base, reviewsLastSyncedAt: "2026-10-18T10:15:00.000Z" }, istTf)).toBe("18/10/2026 15:45");
    expect(reviewsCell(base, utcTf)).toBe("Never");
  });
});
