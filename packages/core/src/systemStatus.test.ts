import { afterAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  createDb,
  jobRuns,
  locations,
  memberships,
  organizations,
  performanceSnapshots,
  profileSnapshots,
  reviewSyncs,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { SYSTEM_JOBS, jobView, recordJobRun } from "./system-jobs";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const at = (iso: string) => new Date(iso);
const run = (startedAt: string, status: "running" | "ok" | "failed" = "ok") => ({
  startedAt: at(startedAt),
  finishedAt: status === "running" ? null : at(startedAt),
  status,
  note: null,
  error: null,
});

describe("SYSTEM_JOBS", () => {
  it("canary: each cron has the schedule text people read (change both together)", () => {
    expect(SYSTEM_JOBS.map((j) => [j.key, j.cron, j.schedule])).toEqual([
      ["review_sync", "15 */2 * * *", "Every 2 hours at :15"],
      ["performance_snapshot", "0 3 * * *", "Daily 03:00"],
      ["profile_snapshot", "30 3 * * *", "Daily 03:30"],
      ["daily_digest", "0 * * * *", "Hourly sweep; sent at 08:00 in each client's time zone"],
      ["monthly_reports", "0 * * * *", "Hourly sweep; sent on the 1st at 09:00 in each client's time zone"],
      ["webhook_purge", "15 4 * * *", "Daily 04:15"],
      ["geogrid_sweep", "*/10 * * * *", "Every 10 minutes"],
    ]);
  });
});

describe("jobView", () => {
  const NOW = at("2026-10-18T10:20:00.000Z");

  it("next run comes from the cron, in UTC", () => {
    expect(jobView("15 */2 * * *", null, NOW).nextRunAt).toBe("2026-10-18T12:15:00.000Z");
    expect(jobView("0 13 * * *", null, NOW).nextRunAt).toBe("2026-10-18T13:00:00.000Z");
    expect(jobView("0 14 1 * *", null, NOW).nextRunAt).toBe("2026-11-01T14:00:00.000Z");
    expect(jobView("0 * * * *", null, NOW).nextRunAt).toBe("2026-10-18T11:00:00.000Z");
  });

  it("late only after two scheduled runs in a row were missed", () => {
    const cron = "15 */2 * * *";
    expect(jobView(cron, run("2026-10-18T10:15:20.000Z"), NOW).late).toBe(false);
    expect(jobView(cron, run("2026-10-18T08:15:30.000Z"), NOW).late).toBe(false); // missed one
    expect(jobView(cron, run("2026-10-18T06:15:10.000Z"), NOW).late).toBe(true); // missed 08:15 and 10:15
    expect(jobView("0 13 * * *", run("2026-10-17T13:00:05.000Z"), NOW).late).toBe(false);
    expect(jobView("0 13 * * *", run("2026-10-15T13:00:05.000Z"), NOW).late).toBe(true);
  });

  it("no recorded run is 'never' and not late (recording starts with this deploy)", () => {
    expect(jobView("15 */2 * * *", null, NOW)).toMatchObject({
      result: "never",
      lastRunAt: null,
      late: false,
    });
  });
});

describe("recordJobRun", () => {
  const latest = async () =>
    (await db.select().from(jobRuns).where(eq(jobRuns.job, "daily_digest")).orderBy(desc(jobRuns.id)).limit(1))[0]!;

  it("records ok with the note, and passes the result through", async () => {
    const out = await recordJobRun(db, "daily_digest", async () => 42, () => "skipped: email not set up");
    expect(out).toBe(42);
    expect(await latest()).toMatchObject({ status: "ok", note: "skipped: email not set up", error: null });
    expect((await latest()).finishedAt).not.toBeNull();
  });

  it("records failed as CODE: message and rethrows", async () => {
    const boom = new CoreError("NOT_CONFIGURED", "no key");
    await expect(
      recordJobRun(db, "daily_digest", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await latest()).toMatchObject({ status: "failed", error: "NOT_CONFIGURED: no key" });
  });
});

describe("system.status", () => {
  async function fixture() {
    const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    const orgId = org!.id;
    const [a, b] = await db
      .insert(workspaces)
      .values([
        { orgId, name: "A" },
        { orgId, name: "B" },
      ])
      .returning();
    const mkUser = async (role: "owner" | "manager" | "client_viewer", workspaceId?: string) => {
      const id = `u-${uniq()}`;
      await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
      await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
      return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
    };
    // Inactive on purpose: other suites fan out over every active location in the test DB.
    const mkLoc = async (workspaceId: string, name: string, extra: object = {}) =>
      (
        await db
          .insert(locations)
          .values({ orgId, workspaceId, name, status: "inactive", googleLocationId: `locations/${uniq()}`, ...extra })
          .returning()
      )[0]!;
    return { orgId, a: a!.id, b: b!.id, mkUser, mkLoc };
  }

  type Out = {
    jobs: { key: string; result: string; late: boolean; error: string | null; lastRunAt: string | null }[];
    locations: {
      id: string;
      name: string;
      needsRelink: boolean;
      reviewsLastSyncedAt: string | null;
      reviewsLastStatus: string | null;
      reviewsLastError: string | null;
      performanceDate: string | null;
      profileLastChangedAt: string | null;
    }[];
    truncated: boolean;
  };

  it("jobs: latest run per job, late flag, error text for owners only", async () => {
    const now = Date.now();
    await db.insert(jobRuns).values([
      { job: "review_sync", startedAt: new Date(now - 7 * 3600_000), finishedAt: new Date(now - 7 * 3600_000), status: "ok" },
      { job: "performance_snapshot", startedAt: new Date(now - 60_000), finishedAt: new Date(now - 30_000), status: "failed", error: "INTERNAL: db down" },
    ]);
    const f = await fixture();
    const owner = (await executeAction(db, await f.mkUser("owner"), "system.status", {})) as Out;
    expect(owner.jobs.map((j) => j.key)).toEqual(SYSTEM_JOBS.map((j) => j.key));
    expect(owner.jobs.find((j) => j.key === "review_sync")).toMatchObject({ result: "ok", late: true });
    expect(owner.jobs.find((j) => j.key === "performance_snapshot")).toMatchObject({
      result: "failed",
      error: "INTERNAL: db down",
    });
    const manager = (await executeAction(db, await f.mkUser("manager"), "system.status", {})) as Out;
    expect(manager.jobs.find((j) => j.key === "performance_snapshot")).toMatchObject({
      result: "failed",
      error: null,
    });
  });

  it("locations: last sync, performance and profile change, in the caller's scope only", async () => {
    const f = await fixture();
    const main = await f.mkLoc(f.a, "Main St");
    const south = await f.mkLoc(f.a, "South", { connectionId: null });
    const other = await f.mkLoc(f.b, "Other workspace");
    const t1 = new Date("2026-10-18T08:15:00.000Z");
    const t2 = new Date("2026-10-18T10:15:00.000Z");
    await db.insert(reviewSyncs).values([
      { orgId: f.orgId, locationId: main.id, status: "done", createdAt: t1, finishedAt: t1 },
      { orgId: f.orgId, locationId: main.id, status: "failed", error: "location_inactive", createdAt: t2, finishedAt: t2 },
    ]);
    await db.insert(performanceSnapshots).values({
      orgId: f.orgId,
      locationId: main.id,
      backfilledAt: t1,
      lastSnapshotDate: "2026-10-17",
    });
    await db.insert(profileSnapshots).values({
      orgId: f.orgId,
      locationId: main.id,
      takenAt: t2,
      source: "nightly",
      data: {},
      hash: "h",
    });

    const owner = (await executeAction(db, await f.mkUser("owner"), "system.status", {})) as Out;
    expect(owner.locations.map((l) => l.name)).toEqual(["Main St", "Other workspace", "South"]);
    expect(owner.locations[0]).toMatchObject({
      reviewsLastSyncedAt: t1.toISOString(), // the last DONE sync
      reviewsLastStatus: "failed", // the newest attempt
      reviewsLastError: "location_inactive",
      performanceDate: "2026-10-17",
      profileLastChangedAt: t2.toISOString(),
    });
    expect(owner.locations.find((l) => l.id === south.id)).toMatchObject({
      needsRelink: true,
      reviewsLastSyncedAt: null,
      reviewsLastStatus: null,
    });
    expect(owner.truncated).toBe(false);

    const viewer = (await executeAction(db, await f.mkUser("client_viewer", f.a), "system.status", {})) as Out;
    expect(viewer.locations.map((l) => l.id).sort()).toEqual([main.id, south.id].sort());
    expect(viewer.locations.some((l) => l.id === other.id)).toBe(false);
  });
});
