import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, locations, locationWriteOps, mediaUploads } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { LOCATION_OP_QUEUE, processLocationOp, sweepDueLocationOps } from "./locationOps/jobs";
import { MEDIA_LIMITS } from "./config/media-limits";
import { handleMediaUploadRequest } from "./media/upload-request";
import { purgeStaleMediaUploads, stageMediaUploads } from "./media/upload";
import { codeOf, makeKit, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const kit = makeKit(db, mock);

/** A PNG header (signature + IHDR) padded with zeros. The parser reads no further. */
function png(w: number, h: number, size = 20_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}
const jobsFor = async (opId: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${LOCATION_OP_QUEUE} and data->>'opId' = ${opId}`
  ).length;
const op = async (id: string) =>
  (await db.select().from(locationWriteOps).where(eq(locationWriteOps.id, id)))[0]!;

// Fixed clock: nothing below reads the real time except the DB defaults.
const NOW = new Date("2026-10-21T12:00:00Z");
const AT = new Date("2026-10-22T09:30:00Z");

let org: Org;
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(LOCATION_OP_QUEUE);
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("scheduled photo to two locations", () => {
  it("holds until due, then publishes to both; a failing location shows its own reason", async () => {
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const l3 = await org.mkLoc(org.a);
    const out = await stageMediaUploads(db, org.manager, {
      locationIds: [l1.row.id, l2.row.id, l3.row.id],
      category: "EXTERIOR",
      file: { filename: "front.png", bytes: png(800, 600) },
      scheduledFor: AT,
      now: NOW,
    });
    expect(out.results).toHaveLength(3);
    const ops = out.results.map((r) => r.operation!);
    for (const o of ops) {
      expect(o).toMatchObject({ status: "scheduled", batchId: out.batchId });
      expect(o.scheduledFor?.toISOString()).toBe(AT.toISOString());
      expect(await jobsFor(o.id)).toBe(0);
    }
    // l3 goes inactive while it waits.
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, l3.row.id));

    const orgIds = [org.orgId];
    expect(
      await sweepDueLocationOps(db, { now: new Date("2026-10-22T09:29:59Z"), orgIds }),
    ).toEqual({ claimed: 0 });
    expect((await op(ops[0]!.id)).status).toBe("scheduled");

    expect(await sweepDueLocationOps(db, { now: AT, orgIds })).toEqual({ claimed: 3 });
    // Re-running claims nothing and queues no second job.
    expect(await sweepDueLocationOps(db, { now: AT, orgIds })).toEqual({ claimed: 0 });
    for (const o of ops) expect(await jobsFor(o.id)).toBe(1);

    const before = mock.calls.filter((c) => c.method === "createMedia").length;
    for (const o of ops) await processLocationOp(db, { opId: o.id }, { client });
    expect(mock.calls.filter((c) => c.method === "createMedia").length - before).toBe(2);
    expect(await op(ops[0]!.id)).toMatchObject({ status: "applied" });
    expect(await op(ops[1]!.id)).toMatchObject({ status: "applied" });
    expect(await op(ops[2]!.id)).toMatchObject({ status: "failed", error: "location_inactive" });
    const listed = await mock.listMedia(l1.parent, {});
    expect(listed.mediaItems).toHaveLength(1);
    // The bytes are gone once Google accepted them.
    const up = (
      await db.select().from(mediaUploads).where(eq(mediaUploads.id, out.results[0]!.uploadId!))
    )[0]!;
    expect(up).toMatchObject({ status: "uploaded", bytes: null });
  });

  it("media.batch lists every location's result; a past or too-far time is refused", async () => {
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const b64 = Buffer.from(png(800, 600)).toString("base64");
    const r = (await kit.run(org.manager, "media.uploadMany", {
      locationIds: [l1.row.id, l2.row.id],
      category: "INTERIOR",
      filename: "a.png",
      contentBase64: b64,
    })) as { batchId: string; results: { operation: { status: string } }[] };
    expect(r.results.map((x) => x.operation.status)).toEqual(["pending", "pending"]);
    const batch = (await kit.run(org.manager, "media.batch", { workspaceId: org.a, batchId: r.batchId })) as {
      items: { locationId: string; operation: { status: string } }[];
    };
    expect(batch.items.map((i) => i.locationId).sort()).toEqual([l1.row.id, l2.row.id].sort());

    const base = {
      locationIds: [l1.row.id],
      category: "INTERIOR",
      filename: "a.png",
      contentBase64: b64,
    };
    expect(
      await codeOf(
        kit.run(org.manager, "media.uploadMany", { ...base, scheduledFor: "2020-01-01T00:00:00Z" }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        kit.run(org.manager, "media.uploadMany", { ...base, scheduledFor: "2099-01-01T00:00:00Z" }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("a refused batch throws; a batch with some good locations reports the bad one and still writes", async () => {
    const mine = await org.mkLoc(org.a);
    const other = await org.mkLoc(org.b);
    // Every location refused (a client approver cannot edit profiles): the whole call is refused.
    const refused = stageMediaUploads(db, org.approverA, {
      locationIds: [mine.row.id, other.row.id],
      category: "EXTERIOR",
      file: { filename: "x.png", bytes: png(800, 600) },
      now: NOW,
    });
    expect(await codeOf(refused)).toBe("FORBIDDEN");
    const manager = await stageMediaUploads(db, org.manager, {
      locationIds: [mine.row.id, "00000000-0000-4000-8000-000000000000"],
      category: "EXTERIOR",
      file: { filename: "x.png", bytes: png(800, 600) },
      now: NOW,
    });
    expect(manager.results[0]!.operation?.status).toBe("pending");
    expect(manager.results[1]).toMatchObject({ operation: null, error: "NOT_FOUND" });
  });
});

describe("purge keeps a photo that is still waiting for its time", () => {
  it("drops an old abandoned upload but not a scheduled one", async () => {
    const l = await org.mkLoc(org.a);
    const stage = (scheduledFor: Date | null) =>
      stageMediaUploads(db, org.manager, {
        locationIds: [l.row.id],
        category: "EXTERIOR",
        file: { filename: "p.png", bytes: png(800, 600) },
        scheduledFor,
        now: new Date(),
      });
    const waiting = (await stage(new Date(Date.now() + 3_600_000))).results[0]!;
    const abandoned = (await stage(null)).results[0]!;
    const old = new Date(Date.now() - 30 * 86_400_000);
    await db
      .update(mediaUploads)
      .set({ createdAt: old })
      .where(eq(mediaUploads.id, waiting.uploadId!));
    await db
      .update(mediaUploads)
      .set({ createdAt: old })
      .where(eq(mediaUploads.id, abandoned.uploadId!));
    await purgeStaleMediaUploads(db);
    const row = async (id: string) =>
      (await db.select().from(mediaUploads).where(eq(mediaUploads.id, id)))[0]!;
    expect((await row(waiting.uploadId!)).bytes).not.toBeNull();
    expect((await row(abandoned.uploadId!)).bytes).toBeNull();
    expect(MEDIA_LIMITS.upload.failedRetentionDays).toBeLessThan(30);
  });
});

describe("POST /api/media/upload with several locations and a time", () => {
  it("returns one result per location and holds the ops as scheduled", async () => {
    const l1 = await org.mkLoc(org.a);
    const l2 = await org.mkLoc(org.a);
    const now = Date.now();
    const session = {
      session: { createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000) },
      user: { id: org.ownerId, email: `${org.ownerId}@example.test`, twoFactorEnabled: true },
    };
    const form = (extra: Record<string, string>) => {
      const f = new FormData();
      f.append("locationId", l1.row.id);
      f.append("locationId", l2.row.id);
      f.set("category", "EXTERIOR");
      f.set("file", new File([png(800, 600) as unknown as Blob], "p.png", { type: "image/png" }));
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      return new Request("http://localhost/api/media/upload", { method: "POST", body: f });
    };
    const call = (extra: Record<string, string>) =>
      handleMediaUploadRequest(form(extra), { db, getSession: async () => session });
    const at = new Date(now + 3_600_000).toISOString();
    const ok = await call({ scheduledFor: at });
    expect(ok.status).toBe(202);
    const body = (await ok.json()) as {
      batchId: string;
      results: { locationId: string; operation: { status: string; scheduledFor: string } }[];
    };
    expect(body.results.map((r) => r.operation.status)).toEqual(["scheduled", "scheduled"]);
    expect(body.results[0]!.operation.scheduledFor).toBe(at);
    expect((await call({ scheduledFor: "tomorrow" })).status).toBe(400);
    expect((await call({ scheduledFor: "2020-01-01T00:00:00Z" })).status).toBe(400);
  });
});

describe("media.cancelScheduled", () => {
  const stageOne = async (when: Date = AT) => {
    const l = await org.mkLoc(org.a);
    const out = await stageMediaUploads(db, org.manager, {
      locationIds: [l.row.id],
      category: "EXTERIOR",
      file: { filename: "c.png", bytes: png(800, 600) },
      scheduledFor: when,
      now: NOW,
    });
    const r = out.results[0]!;
    return { opId: r.operation!.id, uploadId: r.uploadId! };
  };
  const upload = async (id: string) =>
    (await db.select().from(mediaUploads).where(eq(mediaUploads.id, id)))[0]!;
  const cancel = (actor: Parameters<typeof kit.run>[0], opId: string, workspaceId = org.a) =>
    kit.run(actor, "media.cancelScheduled", { workspaceId, opId }) as Promise<{
      cancelled: boolean;
      operation: { status: string };
    }>;

  it("cancels while scheduled: terminal status, bytes purged, audited, never swept", async () => {
    const { opId, uploadId } = await stageOne();
    const r = await cancel(org.manager, opId);
    expect(r).toMatchObject({ cancelled: true, operation: { status: "cancelled" } });
    expect(await op(opId)).toMatchObject({ status: "cancelled" });
    expect(await upload(uploadId)).toMatchObject({ bytes: null, status: "purged" });
    expect(
      (await kit.auditRows(org.orgId, "media.upload_cancelled")).some((a) => a.entityId === opId),
    ).toBe(true);
    // Even long past its time, the sweep leaves it alone and queues no job.
    await sweepDueLocationOps(db, { now: new Date("2027-01-01T00:00:00Z"), orgIds: [org.orgId] });
    expect(await op(opId)).toMatchObject({ status: "cancelled" });
    expect(await jobsFor(opId)).toBe(0);
    // A second cancel changes nothing and says so.
    expect(await cancel(org.manager, opId)).toMatchObject({
      cancelled: false,
      operation: { status: "cancelled" },
    });
  });

  it("after the sweep claimed it: reports already sent and changes nothing", async () => {
    const { opId, uploadId } = await stageOne();
    await sweepDueLocationOps(db, { now: AT, orgIds: [org.orgId] });
    expect(await op(opId)).toMatchObject({ status: "pending" });
    const r = await cancel(org.manager, opId);
    expect(r).toMatchObject({ cancelled: false, operation: { status: "pending" } });
    expect(await op(opId)).toMatchObject({ status: "pending" });
    expect((await upload(uploadId)).bytes).not.toBeNull();
    expect(await jobsFor(opId)).toBe(1);
  });

  it("refuses another client's workspace, another organisation, and a role that cannot edit", async () => {
    const { opId } = await stageOne();
    const other = await kit.makeOrg();
    // Same org, a client approver of the other client (workspace b) naming workspace a.
    expect(await codeOf(cancel(org.approverB, opId))).toBe("FORBIDDEN");
    // Another organisation's owner, even with their own workspace id.
    expect(await codeOf(cancel(other.owner, opId, other.a))).toBe("NOT_FOUND");
    // Right workspace, wrong role.
    expect(await codeOf(cancel(org.viewerA, opId))).toBe("FORBIDDEN");
    expect(await op(opId)).toMatchObject({ status: "scheduled" });
  });
});
