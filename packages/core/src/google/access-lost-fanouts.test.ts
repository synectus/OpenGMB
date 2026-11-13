// OPS3: every SCHEDULED fan-out that queues per-location Google work leaves a connection with lost access alone.
// Public on purpose (no .private. in the name): the community edition runs it too. It fails on zero and prints its denominator.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, googleConnections, memberships, reviewSyncs, users } from "@opengmb/db";
import { encryptSecret } from "../crypto";
import { ensureQueues } from "../jobs";
import { enqueueLocationCenterBackfill } from "../locations/center-backfill";
import { LOCATION_CENTER_QUEUE } from "../locations/center";
import { CUSTOMER_MEDIA_SCAN_QUEUE, enqueueCustomerMediaScans } from "../media/customer";
import { enqueueNightlySnapshots, PERFORMANCE_SNAPSHOT_QUEUE } from "../performance/snapshot";
import { enqueueNightlyProfileSnapshots, PROFILE_SNAPSHOT_QUEUE } from "../profile/watch";
import { enqueueScheduledReviewSyncs, REVIEW_SYNC_QUEUE } from "../reviews/sync";
import { makeKit, uniq } from "../testkit";
import { runNotificationRegistration } from "./notification-registration";
import { MockGoogleClient } from "./mock-client";
import { setSharedMockGoogleClient } from "./factory";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);

let orgId: string;
let healthy: string; // location id on a healthy connection
let lost: string; // location id on a connection whose access was removed
let healthyConn: string;
let lostConn: string;

beforeAll(async () => {
  await ensureQueues(url!, [REVIEW_SYNC_QUEUE, PERFORMANCE_SNAPSHOT_QUEUE, PROFILE_SNAPSHOT_QUEUE, CUSTOMER_MEDIA_SCAN_QUEUE, LOCATION_CENTER_QUEUE]);
  const org = await kit.makeOrg();
  orgId = org.orgId;
  const good = await org.mkLoc(org.a);
  healthy = good.row.id;
  healthyConn = good.row.connectionId!;
  const [owner] = await db.select().from(users).where(eq(users.id, org.ownerId));
  const [other] = await db
    .insert(googleConnections)
    .values({ orgId, userId: owner!.id, googleAccountId: `sub-${uniq()}`, googleAccountEmail: "lost@example.test", refreshTokenEnc: encryptSecret("rt"), scopes: [], accessLostAt: new Date() })
    .returning();
  lostConn = other!.id;
  lost = (await org.mkLoc(org.a, { connectionId: lostConn })).row.id;
  void memberships;
});
afterAll(async () => {
  await kit.deactivateAll();
  await client.end();
});

const jobsFor = async (queue: string, locationId: string) =>
  (await db.execute(sql`select 1 from pgboss.job where name = ${queue} and data->>'locationId' = ${locationId}`)).length;
const syncsFor = async (locationId: string) => (await db.select().from(reviewSyncs).where(eq(reviewSyncs.locationId, locationId))).length;

/** One entry per scheduled fan-out: how to run it for our org, and how many items it queued for a location. */
const FANOUTS: { name: string; run: () => Promise<unknown>; queuedFor: (locationId: string) => Promise<number> }[] = [
  { name: "reviews.schedule (enqueueScheduledReviewSyncs)", run: () => enqueueScheduledReviewSyncs(db, { orgIds: [orgId] }), queuedFor: syncsFor },
  { name: "performance schedule (enqueueNightlySnapshots)", run: () => enqueueNightlySnapshots(db, { orgIds: [orgId] }), queuedFor: (l) => jobsFor(PERFORMANCE_SNAPSHOT_QUEUE, l) },
  { name: "profile watch schedule (enqueueNightlyProfileSnapshots)", run: () => enqueueNightlyProfileSnapshots(db, { orgId }), queuedFor: (l) => jobsFor(PROFILE_SNAPSHOT_QUEUE, l) },
  { name: "customer media schedule (enqueueCustomerMediaScans)", run: () => enqueueCustomerMediaScans(db, { orgId }), queuedFor: (l) => jobsFor(CUSTOMER_MEDIA_SCAN_QUEUE, l) },
  { name: "location center backfill (enqueueLocationCenterBackfill)", run: () => enqueueLocationCenterBackfill(db, { orgId }), queuedFor: (l) => jobsFor(LOCATION_CENTER_QUEUE, l) },
];

describe("scheduled fan-outs skip a connection whose Google access was removed", () => {
  it("queues the healthy location and not the lost one, for every fan-out", async () => {
    let checked = 0;
    for (const f of FANOUTS) {
      await f.run();
      expect(await f.queuedFor(healthy), `${f.name}: canary (healthy location) must be queued`).toBeGreaterThan(0);
      expect(await f.queuedFor(lost), `${f.name}: lost-access location must be skipped`).toBe(0);
      checked++;
    }
    console.log(`[OPS3 sweep] fan-outs checked: ${checked} of ${FANOUTS.length} listed (${FANOUTS.map((f) => f.name.split(" ")[0]).join(", ")})`);
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(FANOUTS.length);
  });

  it("the daily notification registration is the exception: it still takes the lost connection (its self-recovery probe) and the healthy one", async () => {
    process.env.PUBSUB_TOPIC = "projects/p/topics/t";
    setSharedMockGoogleClient(new MockGoogleClient());
    try {
      const probed = await runNotificationRegistration(db, { connectionId: lostConn, scope: "all" });
      expect(probed.accounts).toBeGreaterThan(0);
      const taken = await runNotificationRegistration(db, { connectionId: healthyConn, scope: "all" });
      expect(taken.accounts).toBeGreaterThan(0);
      console.log("[OPS3 sweep] notification registration probes: 1 lost connection taken, 1 healthy connection taken; the other 5 fan-outs skip lost ones");
    } finally {
      setSharedMockGoogleClient(null);
      delete process.env.PUBSUB_TOPIC;
    }
  });
});
