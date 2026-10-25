import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@opengmb/db";
import { GOOGLE_LIMITS } from "../config/google-limits";
import { googleFailure } from "../reviews/reply-jobs";
import { GoogleOrgLimitError } from "./errors";
import { createGoogleClient } from "./factory";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const LIMIT = GOOGLE_LIMITS.orgFairUse.limit;
const WINDOW = GOOGLE_LIMITS.orgFairUse.windowMs;
const T0 = Math.floor(Date.UTC(2033, 0, 1) / WINDOW) * WINDOW;
const clock = (t: number) => ({ now: () => t, sleep: async () => {}, random: () => 0.5 });
const uniq = () => `org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const clientFor = (orgId: string, t: number) =>
  createGoogleClient({ db, connection: { refreshTokenEnc: "", orgId }, clock: clock(t) });

describe("H8 per-org Google fair use (mock mode uses the same limiter)", () => {
  it("config carries Google's source URL and a verified-on date", () => {
    expect(GOOGLE_LIMITS.orgFairUse.sourceUrl).toMatch(/^https:\/\/developers\.google\.com\//);
    expect(GOOGLE_LIMITS.orgFairUse.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LIMIT).toBe(Math.floor(GOOGLE_LIMITS.projectQpm.limit / GOOGLE_LIMITS.orgFairUse.minOrgsAtFullRate));
  });

  it("one org over its limit gets a clear error while another org keeps working", async () => {
    const a = uniq();
    const b = uniq();
    const ca = clientFor(a, T0 + 5_000);
    const cb = clientFor(b, T0 + 5_000);
    for (let i = 0; i < LIMIT; i++) await ca.listAccounts();
    const err = await ca.listAccounts().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleOrgLimitError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toBe("Google request limit for your account reached, try again in 1 minute.");
    await expect(cb.listAccounts()).resolves.toBeDefined();
    // the next window frees org A again
    await expect(clientFor(a, T0 + WINDOW + 1).listAccounts()).resolves.toBeDefined();
  });

  it("jobs treat it as retryable, not a permanent Google failure", () => {
    expect(googleFailure(new GoogleOrgLimitError(30_000))).toBeNull();
  });
});
