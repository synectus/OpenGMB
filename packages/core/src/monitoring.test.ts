import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";
import { eq, notLike } from "drizzle-orm";
import { createDb, errorEvents, googleApiCalls, memberships, monitorState, organizations, users } from "@opengmb/db";
import { loadActor } from "./actor";
import { executeAction } from "./executor";
import { MONITORING } from "./config/monitoring";
import { setEmailSender } from "./email";
import {
  checkWorker,
  collectFailedJobs,
  fingerprintOf,
  googleUsage,
  recordError,
  recordGoogleCall,
  recordHeartbeat,
  sanitizeMessage,
} from "./index";

const { db, sql } = createDb(process.env.DATABASE_URL_TEST!);
afterAll(() => sql.end());

const sent: { to: string; subject: string; text: string }[] = [];
beforeEach(async () => {
  sent.length = 0;
  process.env.ALERT_EMAIL = "ops@example.test";
  setEmailSender(async (m) => void sent.push({ to: m.to, subject: m.subject, text: m.text }));
  await db.delete(errorEvents);
  // Leave other suites' keys alone: platformLimits.test claims limit_alert:* rows in the same table.
  await db.delete(monitorState).where(notLike(monitorState.key, "limit_alert:%"));
  await db.delete(googleApiCalls);
});
afterAll(() => {
  setEmailSender(null);
  delete process.env.ALERT_EMAIL;
});

const T0 = new Date("2026-10-20T10:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);
const boom = () => new Error("Connection to postgres://u:hunter2@db:5432/x refused for jane@acme.com");

describe("recordError (forced error)", () => {
  it("emails once per fingerprint per window, counts every repeat, and the window reopens", async () => {
    expect(await recordError(db, "web", boom(), T0)).toBe(true);
    for (let i = 1; i <= 5; i++) expect(await recordError(db, "web", boom(), after(i * 1000))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ops@example.test");
    const [row] = await db.select().from(errorEvents);
    expect(row!.count).toBe(6);
    // canary: just inside the window still stays quiet, exactly at the window sends again
    expect(await recordError(db, "web", boom(), after(MONITORING.alertWindowMs - 1))).toBe(false);
    expect(await recordError(db, "web", boom(), after(MONITORING.alertWindowMs))).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("a different error is its own fingerprint and alerts on its own", async () => {
    await recordError(db, "web", new Error("first"), T0);
    await recordError(db, "mcp", new Error("second"), T0);
    expect(sent).toHaveLength(2);
  });

  it("racing writers send one email", async () => {
    await Promise.all(Array.from({ length: 8 }, () => recordError(db, "worker", boom(), T0)));
    expect(sent).toHaveLength(1);
    expect((await db.select().from(errorEvents))[0]!.count).toBe(8);
  });

  it("stores and mails no secret, email address or connection string", async () => {
    await recordError(db, "web", boom(), T0);
    const stored = (await db.select().from(errorEvents))[0]!.message;
    for (const text of [stored, sent[0]!.text]) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("jane@acme.com");
      expect(text).not.toContain("postgres://");
    }
  });

  it("without an email provider the alert is logged as [alert]", async () => {
    setEmailSender(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordError(db, "web", new Error("logged only"), T0);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith("[alert] Error in web"))).toBe(true);
    log.mockRestore();
  });

  it("fingerprint ignores digits and ids but not the message", () => {
    const a = fingerprintOf("web", { name: "Error", message: "row 17 missing" });
    expect(fingerprintOf("web", { name: "Error", message: "row 9001 missing" })).toBe(a);
    expect(fingerprintOf("web", { name: "Error", message: "row 17 gone" })).not.toBe(a);
    expect(fingerprintOf("worker", { name: "Error", message: "row 17 missing" })).not.toBe(a);
  });

  it("sanitizeMessage strips tokens, uuids and caps length", () => {
    const s = sanitizeMessage(
      `Bearer abc.def password=hunter2 id 123e4567-e89b-12d3-a456-426614174000 ${"x".repeat(500)}`,
    );
    expect(s).not.toMatch(/hunter2|abc\.def|123e4567/);
    expect(s.length).toBeLessThanOrEqual(300);
  });
});

describe("checkWorker (stopped worker)", () => {
  it("no heartbeat ever: nothing to alert", async () => {
    expect(await checkWorker(db, T0)).toBe("unknown");
    expect(sent).toHaveLength(0);
  });

  it("a fresh heartbeat is ok; a stale one alerts once per outage; a return sends one recovery", async () => {
    await recordHeartbeat(db, T0);
    expect(await checkWorker(db, after(MONITORING.workerStaleMs))).toBe("ok");
    expect(sent).toHaveLength(0);

    expect(await checkWorker(db, after(MONITORING.workerStaleMs + 1))).toBe("down-alerted");
    expect(await checkWorker(db, after(MONITORING.workerStaleMs + 60_000))).toBe("down");
    expect(await checkWorker(db, after(MONITORING.workerStaleMs + 120_000))).toBe("down");
    expect(sent.map((m) => m.subject)).toEqual(["[SynGMB] Worker is down"]);

    await recordHeartbeat(db, after(20 * 60_000));
    expect(await checkWorker(db, after(20 * 60_000 + 1000))).toBe("recovered");
    expect(await checkWorker(db, after(20 * 60_000 + 2000))).toBe("ok");
    expect(sent.map((m) => m.subject)).toEqual(["[SynGMB] Worker is down", "[SynGMB] Worker is back"]);

    // a second outage alerts again
    expect(await checkWorker(db, after(60 * 60_000))).toBe("down-alerted");
    expect(sent).toHaveLength(3);
  });
});

describe("collectFailedJobs", () => {
  it("records a job that failed for good, once, and starts from now on the first run", async () => {
    const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
    await boss.start();
    const queue = "h2-test-fail";
    await boss.createQueue(queue, { retryLimit: 0 });
    await sql`delete from pgboss.job where name = ${queue}`;
    expect(await collectFailedJobs(db, new Date(Date.now() - 1000))).toBe(0);
    const id = await boss.send(queue, {}, { retryLimit: 0 });
    const [job] = await boss.fetch(queue);
    expect(job!.id).toBe(id);
    await boss.fail(queue, id!, { message: "queue exploded for acct 4242" });
    await boss.stop();
    expect(await collectFailedJobs(db)).toBe(1);
    expect(await collectFailedJobs(db)).toBe(0);
    const [row] = await db.select().from(errorEvents);
    expect(row!.source).toBe("worker");
    expect(row!.message).toContain(`job:${queue}`);
    expect(sent).toHaveLength(1);
    await sql`delete from pgboss.job where name = ${queue}`;
  });
});

describe("Google usage", () => {
  it("counts per day and method and reads them back against the 300/min limit", async () => {
    // Fixed far-past dates, not T0: throttled-client tests in other files write real-time rows
    // into this shared table concurrently, and those land inside any 14-day window near today.
    const past = new Date("2001-09-09T10:00:00Z");
    const pastAfter = (ms: number) => new Date(past.getTime() + ms);
    await recordGoogleCall(db, "listReviews", past);
    await recordGoogleCall(db, "listReviews", past);
    await recordGoogleCall(db, "getLocation", past);
    await recordGoogleCall(db, "listReviews", pastAfter(86_400_000));
    const u = await googleUsage(db, pastAfter(86_400_000));
    expect(u.limitPerMinute).toBe(300);
    // googleUsage has no upper bound, so real-time rows from other files can appear; assert only on this test's days.
    const mine = u.days.filter((d) => d.day.startsWith("2001-09-"));
    expect(mine.map((d) => [d.day, d.total])).toEqual([
      ["2001-09-10", 1],
      ["2001-09-09", 3],
    ]);
    expect(mine[1]!.methods[0]).toEqual({ method: "listReviews", calls: 2 });
  });

  it("is counted by the throttled client, retries included", async () => {
    const { ThrottledGoogleClient } = await import("./google/throttled-client");
    const { MockGoogleClient } = await import("./google/mock-client");
    const c = new ThrottledGoogleClient(new MockGoogleClient(), db, { sleep: async () => {} });
    await c.listAccounts();
    const [row] = await db.select().from(googleApiCalls).where(eq(googleApiCalls.method, "listAccounts"));
    expect(row!.calls).toBe(1);
  });
});

describe("monitoring.overview", () => {
  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  async function owner(email: string) {
    const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email, emailVerified: true });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role: "owner" });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  }

  it("is refused for owners who are not platform admins, allowed for a platform admin", async () => {
    const admin = `ops-${uniq()}@example.test`;
    process.env.PLATFORM_ADMIN_EMAILS = admin;
    try {
      await recordError(db, "web", new Error("visible to platform admins only"), T0);
      const call = (a: Awaited<ReturnType<typeof owner>>) => executeAction(db, a, "monitoring.overview", {});
      await expect(call(await owner(`o-${uniq()}@example.test`))).rejects.toMatchObject({ code: "FORBIDDEN" });
      const out = (await call(await owner(admin))) as { errors: { message: string }[]; google: { limitPerMinute: number } };
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]!.message).toContain("visible to platform admins only");
      expect(out.google.limitPerMinute).toBe(300);
    } finally {
      delete process.env.PLATFORM_ADMIN_EMAILS;
    }
  });
});
