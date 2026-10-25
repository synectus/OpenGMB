import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  organizations,
  reviewSyncs,
  users,
  workspaces,
} from "@opengmb/db";
import { seedMockGoogleConnection } from "./google/dev-seed";
import {
  enqueueScheduledReviewSyncs,
  REVIEW_SCHEDULE_QUEUE,
  REVIEW_SYNC_QUEUE,
} from "./reviews/sync";
import { REVIEWS_CONFIG } from "./config/reviews";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REVIEW_SYNC_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("scheduled review sync", () => {
  it("has a 2 hourly cron and a schedule queue name", () => {
    expect(REVIEWS_CONFIG.syncCron).toBe("15 */2 * * *");
    expect(REVIEW_SCHEDULE_QUEUE).toBe("reviews.schedule");
  });

  it("queues one sync per active linked location, skips the rest, never duplicates", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `org-${uniq()}` })
      .returning();
    const orgId = org!.id;
    const [ws] = await db.insert(workspaces).values({ orgId, name: "A" }).returning();
    const userId = `u-${uniq()}`;
    const email = `${userId}@example.test`;
    await db.insert(users).values({ id: userId, name: "T", email });
    await db.insert(memberships).values({ orgId, userId, role: "owner" });
    const { connectionId } = await seedMockGoogleConnection(db, email);
    const mk = async (
      name: string,
      o: { status?: "active" | "inactive"; linked?: boolean } = {},
    ) => {
      const n = `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
      const linked = o.linked ?? true;
      const [l] = await db
        .insert(locations)
        .values({
          orgId,
          workspaceId: ws!.id,
          name,
          status: o.status ?? "active",
          ...(linked
            ? {
                googleAccountName: `accounts/9${n.slice(-8)}`,
                googleLocationId: `locations/9${n.slice(-10)}`,
                connectionId,
              }
            : {}),
        })
        .returning();
      return l!;
    };
    const l1 = await mk("One");
    const l2 = await mk("Two");
    const pending = await mk("Already pending");
    const off = await mk("Closed", { status: "inactive" });
    const unlinked = await mk("Unlinked", { linked: false });
    await db.insert(reviewSyncs).values({ orgId, locationId: pending.id, requestedBy: null });

    const first = await enqueueScheduledReviewSyncs(db, { orgIds: [orgId] });
    expect(first).toEqual({ locations: 3, queued: 2, skippedPending: 1 });

    const syncs = await db.select().from(reviewSyncs).where(eq(reviewSyncs.orgId, orgId));
    const byLoc = (id: string) => syncs.filter((s) => s.locationId === id);
    expect(byLoc(l1.id)).toHaveLength(1);
    expect(byLoc(l2.id)).toHaveLength(1);
    expect(byLoc(pending.id)).toHaveLength(1);
    expect(byLoc(off.id)).toHaveLength(0);
    expect(byLoc(unlinked.id)).toHaveLength(0);
    const queued = [...byLoc(l1.id), ...byLoc(l2.id)];
    expect(queued.every((s) => s.status === "pending" && s.requestedBy === null)).toBe(true);

    const jobs = await sql`select id from pgboss.job where name = ${REVIEW_SYNC_QUEUE}
      and data->>'syncId' = any(${queued.map((s) => s.id)})`;
    expect(jobs).toHaveLength(2);

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "review_sync.requested"),
          inArray(
            auditLog.entityId,
            queued.map((s) => s.id),
          ),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.surface === "worker" && a.actorType === "system")).toBe(true);
    expect(audits.every((a) => (a.after as { trigger?: string }).trigger === "schedule")).toBe(
      true,
    );

    const second = await enqueueScheduledReviewSyncs(db, { orgIds: [orgId] });
    expect(second).toEqual({ locations: 3, queued: 0, skippedPending: 3 });
    expect(await db.select().from(reviewSyncs).where(eq(reviewSyncs.orgId, orgId))).toHaveLength(3);
  });
});
