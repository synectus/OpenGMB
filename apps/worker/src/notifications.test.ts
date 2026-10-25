import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  googleNotifications,
  locations,
  memberships,
  notificationDigests,
  notifications,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import {
  DIGEST_CRON,
  DIGEST_QUEUE,
  registerDigestSchedule,
  digestZone,
  runDigest,
  type EmailMessage,
} from "./digest";
import { processGoogleNotification } from "./google-notification";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
afterAll(async () => {
  await boss.unschedule(DIGEST_QUEUE).catch(() => {});
  await boss.stop();
  await sql.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const REVIEW_TEXT = "Dr Smith ignored my diabetes and my husband Robert Jones was rude";

async function world() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const [wsA] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `a-${uniq()}` })
    .returning();
  const [wsB] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `b-${uniq()}` })
    .returning();
  const [loc] = await db
    .insert(locations)
    .values({ orgId: org!.id, workspaceId: wsA!.id, name: "Houston Clinic - Downtown" })
    .returning();
  const mk = async (
    role: "owner" | "admin" | "manager" | "client_viewer" | "client_approver",
    workspaceId: string | null,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role, workspaceId });
    return id;
  };
  const gn = async (type: "NEW_REVIEW" | "UPDATED_REVIEW" | "GOOGLE_UPDATE" = "NEW_REVIEW") => {
    const [r] = await db
      .insert(googleNotifications)
      .values({
        orgId: org!.id,
        locationId: loc!.id,
        pubsubMessageId: `m-${uniq()}`,
        type,
        resourceName: "accounts/1/locations/2/reviews/3",
        locationName: "locations/2",
        payload: { notificationType: type, comment: REVIEW_TEXT, reviewText: REVIEW_TEXT },
      })
      .returning();
    return r!.id;
  };
  return { org: org!.id, wsA: wsA!.id, wsB: wsB!.id, loc: loc!.id, mk, gn };
}

const forUser = (userId: string) =>
  db.select().from(notifications).where(eq(notifications.userId, userId));
const auditFor = (orgId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));

describe("processGoogleNotification creates in-app notifications", () => {
  it("owner/admin/manager and clients of the workspace only; no review text anywhere", async () => {
    const w = await world();
    const owner = await w.mk("owner", null);
    const admin = await w.mk("admin", null);
    const manager = await w.mk("manager", null);
    const clientA = await w.mk("client_viewer", w.wsA);
    const clientB = await w.mk("client_approver", w.wsB);
    const id = await w.gn("NEW_REVIEW");
    await processGoogleNotification(db, id);

    for (const u of [owner, admin, manager, clientA]) {
      const rows = await forUser(u);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "google.new_review",
        title: "New review at Houston Clinic - Downtown",
        sourceType: "google_notification",
        sourceId: id,
        readAt: null,
        orgId: w.org,
      });
    }
    expect(await forUser(clientB)).toHaveLength(0);

    const audit = await auditFor(w.org, "notification.create");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      surface: "worker",
      actorType: "system",
      entityType: "google_notification",
      entityId: id,
    });
    expect(audit[0]!.after).toEqual({ recipientCount: 4, kind: "google.new_review" });

    const all = JSON.stringify([
      await db.select().from(notifications).where(eq(notifications.orgId, w.org)),
      audit,
    ]);
    expect(all).not.toContain("diabetes");
    expect(all).not.toContain("Robert");
    const [row] = await db.select().from(googleNotifications).where(eq(googleNotifications.id, id));
    expect(row!.processedAt).not.toBeNull();
  });

  it("titles for the other two types", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW"));
    await processGoogleNotification(db, await w.gn("GOOGLE_UPDATE"));
    expect((await forUser(u)).map((r) => r.title).sort()).toEqual([
      "Google suggested an edit to Houston Clinic - Downtown",
      "Updated review at Houston Clinic - Downtown",
    ]);
  });

  it("re-running creates no duplicates and no second audit row", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    const id = await w.gn();
    await processGoogleNotification(db, id);
    await processGoogleNotification(db, id);
    await Promise.all([processGoogleNotification(db, id), processGoogleNotification(db, id)]);
    expect(await forUser(u)).toHaveLength(1);
    expect(await auditFor(w.org, "notification.create")).toHaveLength(1);
  });

  it("the unique constraint also guards the insert itself", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    const v = { orgId: w.org, userId: u, kind: "k", title: "t", sourceType: "s", sourceId: "1" };
    await db.insert(notifications).values(v);
    await expect(db.insert(notifications).values(v)).rejects.toThrow();
  });

  it("an unknown notification id is skipped without throwing", async () => {
    await expect(processGoogleNotification(db, crypto.randomUUID())).resolves.toBeUndefined();
  });
});

describe("daily digest", () => {
  const NOW = new Date("2026-10-12T13:00:00.000Z");
  const deps = (org: string, sent: EmailMessage[], over: Record<string, unknown> = {}) => ({
    sendEmail: async (m: EmailMessage) => void sent.push(m),
    apiKey: "re_test",
    from: "OpenGMB <notifications@example.test>",
    appUrl: "https://app.example.test",
    now: () => NOW,
    orgIds: [org],
    ...over,
  });
  const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  async function seed() {
    const w = await world();
    const u = await w.mk("owner", null);
    const u2 = await w.mk("manager", null);
    // Two fresh notifications through the real producer, then age them to the fake clock.
    await processGoogleNotification(db, await w.gn("NEW_REVIEW"));
    await processGoogleNotification(db, await w.gn("GOOGLE_UPDATE"));
    await db
      .update(notifications)
      .set({ createdAt: ago(2) })
      .where(eq(notifications.orgId, w.org));
    return { ...w, u, u2 };
  }
  const digestRows = (org: string) =>
    db.select().from(notificationDigests).where(eq(notificationDigests.orgId, org));

  it("sends once per user, a second run the same day sends nothing", async () => {
    const w = await seed();
    const sent: EmailMessage[] = [];
    await runDigest(db, deps(w.org, sent));
    const mine = sent.filter(
      (m) => m.to.startsWith("u-") && [w.u, w.u2].some((id) => m.to === `${id}@example.test`),
    );
    expect(mine).toHaveLength(2);
    const m = mine.find((x) => x.to === `${w.u}@example.test`)!;
    expect(m.subject).toBe("OpenGMB: 2 new notifications");
    expect(m.from).toBe("OpenGMB <notifications@example.test>");
    expect(m.text).toContain("New reviews: 1");
    expect(m.text).toContain("Google suggested edits: 1");
    expect(m.text).toContain("Houston Clinic - Downtown");
    expect(m.text).toContain("https://app.example.test");
    expect(m.html).toContain("Houston Clinic - Downtown");
    expect(m.html).toContain('href="https://app.example.test"');
    for (const s of [m.text, m.html, m.subject]) {
      expect(s).not.toContain("diabetes");
      expect(s).not.toContain("Robert");
    }
    const rows = await digestRows(w.org);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.status === "sent" &&
          r.sentAt &&
          r.notificationCount === 2 &&
          r.digestDate === "2026-10-12",
      ),
    ).toBe(true);
    const audit = await auditFor(w.org, "notification.digest_sent");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ surface: "worker", actorType: "system" });
    expect(audit[0]!.after).toEqual({ count: 2, digestDate: "2026-10-12" });
    expect(JSON.stringify(audit)).not.toContain("Houston");

    // Scoped to this test's users: other test files create unread notifications concurrently.
    const mineCount = () =>
      sent.filter((x) => [w.u, w.u2].some((id) => x.to === `${id}@example.test`)).length;
    const before = mineCount();
    await runDigest(db, deps(w.org, sent));
    expect(sent.filter((x) => x.to.endsWith("@example.test") && x.to.includes(w.u)).length).toBe(1);
    expect(mineCount()).toBe(before);
    expect(await auditFor(w.org, "notification.digest_sent")).toHaveLength(2);
  });

  it("goes out at 08:00 in the client's zone, once per local day", async () => {
    const w = await seed();
    await db.update(workspaces).set({ timeZone: "Asia/Kolkata" }).where(eq(workspaces.id, w.wsA));
    const mineOf = (sent: EmailMessage[]) => sent.filter((m) => m.to === `${w.u}@example.test`);
    // 02:00Z on the 12th is 07:30 IST: still before the client's morning (notifications are 2h old)
    const early = new Date("2026-10-12T02:00:00.000Z");
    const sent: EmailMessage[] = [];
    await runDigest(db, deps(w.org, sent, { now: () => early }));
    expect(mineOf(sent)).toHaveLength(0);
    expect(await digestRows(w.org)).toHaveLength(0);
    // 03:00Z is 08:30 IST: due; the claim is the Kolkata date
    const due = new Date("2026-10-12T03:00:00.000Z");
    await db.update(notifications).set({ createdAt: new Date(due.getTime() - 2 * 3600_000) }).where(eq(notifications.orgId, w.org));
    await runDigest(db, deps(w.org, sent, { now: () => due }));
    expect(mineOf(sent)).toHaveLength(1);
    expect((await digestRows(w.org))[0]!.digestDate).toBe("2026-10-12");
    // an hour later is the same local date: nothing more is sent
    await runDigest(db, deps(w.org, sent, { now: () => new Date(due.getTime() + 3600_000) }));
    expect(mineOf(sent)).toHaveLength(1);
  });

  it("digestZone: most items win, ties go to the first zone alphabetically, then the org default, then UTC", () => {
    expect(digestZone(["Asia/Kolkata", "America/Chicago", "America/Chicago", null], "UTC")).toBe("America/Chicago");
    expect(digestZone(["Asia/Kolkata", "America/Chicago"], undefined)).toBe("America/Chicago");
    expect(digestZone([null, null], "Australia/Sydney")).toBe("Australia/Sydney");
    expect(digestZone([], undefined)).toBe("UTC");
  });

  it("counts review.negative notifications under a clear label, without review text", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    await db.insert(notifications).values({
      orgId: w.org,
      userId: u,
      kind: "review.negative",
      title: "1★ review at Houston Clinic - Downtown",
      link: "/reviews?review=x",
      sourceType: "review",
      sourceId: `x:${uniq()}`,
      createdAt: ago(2),
    });
    const sent: EmailMessage[] = [];
    await runDigest(db, deps(w.org, sent));
    const m = sent.find((x) => x.to === `${u}@example.test`)!;
    expect(m.text).toContain("Negative reviews: 1");
    expect(m.html).toContain("Negative reviews: 1");
    expect(m.text).not.toContain("review.negative");
    expect(m.text + m.html).not.toContain("1★ review at");
  });

  it("missing key: nothing sent and no digest row", async () => {
    const w = await seed();
    const sent: EmailMessage[] = [];
    for (const apiKey of ["", undefined]) {
      await runDigest(db, deps(w.org, sent, { apiKey }));
    }
    expect(sent).toHaveLength(0);
    expect(await digestRows(w.org)).toHaveLength(0);
    // Adding the key later still sends the same day.
    await runDigest(db, deps(w.org, sent));
    expect(sent.filter((m) => m.to.includes(w.u))).toHaveLength(1);
  });

  it("send failure removes the claim; the retry sends", async () => {
    const w = await seed();
    const sent: EmailMessage[] = [];
    let fail = true;
    const flaky = async (m: EmailMessage) => {
      if (fail && m.to.includes(w.u)) throw new Error("resend down");
      sent.push(m);
    };
    await expect(runDigest(db, deps(w.org, sent, { sendEmail: flaky }))).rejects.toThrow(/1 send/);
    const rows = await digestRows(w.org);
    expect(rows.map((r) => r.userId)).toEqual([w.u2]); // failed user's claim is gone
    fail = false;
    await runDigest(db, deps(w.org, sent, { sendEmail: flaky }));
    expect(sent.filter((m) => m.to.includes(w.u))).toHaveLength(1);
    expect(sent.filter((m) => m.to.includes(w.u2))).toHaveLength(1);
    expect(await digestRows(w.org)).toHaveLength(2);
  });

  it("excludes notifications older than 24h and already-read ones", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    const v = await w.mk("manager", null);
    const base = { orgId: w.org, kind: "google.new_review", title: "t", sourceType: "s" };
    await db.insert(notifications).values([
      { ...base, userId: u, sourceId: "old", createdAt: ago(25) },
      { ...base, userId: v, sourceId: "read", createdAt: ago(1), readAt: ago(0.5) },
      { ...base, userId: v, sourceId: "new", createdAt: ago(23) },
    ]);
    const sent: EmailMessage[] = [];
    await runDigest(db, deps(w.org, sent));
    expect(sent.filter((m) => m.to.includes(u))).toHaveLength(0);
    const mv = sent.filter((m) => m.to.includes(v));
    expect(mv).toHaveLength(1);
    expect(mv[0]!.subject).toBe("OpenGMB: 1 new notifications");
    expect((await digestRows(w.org)).map((r) => r.userId)).toEqual([v]);
  });

  it("a new UTC day sends a new digest", async () => {
    const w = await world();
    const u = await w.mk("owner", null);
    await db.insert(notifications).values({
      orgId: w.org,
      userId: u,
      kind: "k",
      title: "t",
      sourceType: "s",
      sourceId: "1",
      createdAt: ago(1),
    });
    const sent: EmailMessage[] = [];
    await runDigest(db, deps(w.org, sent));
    const tomorrow = new Date(NOW.getTime() + 24 * 3600_000);
    await db
      .update(notifications)
      .set({ createdAt: new Date(tomorrow.getTime() - 3600_000) })
      .where(eq(notifications.userId, u));
    await runDigest(db, deps(w.org, sent, { now: () => tomorrow }));
    expect(sent.filter((m) => m.to.includes(u))).toHaveLength(2);
    expect((await digestRows(w.org)).map((r) => r.digestDate).sort()).toEqual([
      "2026-10-12",
      "2026-10-13",
    ]);
  });
});

describe("digest schedule", () => {
  beforeAll(async () => {
    boss.on("error", () => {});
    await boss.start();
  });
  it("registerDigestSchedule creates the queue and an hourly sweep, idempotently", async () => {
    await registerDigestSchedule(boss);
    await registerDigestSchedule(boss);
    const schedules = await boss.getSchedules(DIGEST_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ name: DIGEST_QUEUE, cron: "0 * * * *", timezone: "UTC" });
    expect(DIGEST_CRON).toBe("0 * * * *");
  });
});
