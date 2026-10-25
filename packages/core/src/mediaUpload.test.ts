import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  createDb,
  locationWriteOps,
  mcpProposals,
  mediaUploads,
  users,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { createApiToken, verifyApiToken } from "./apiTokens";
import { MEDIA_LIMITS } from "./config/media-limits";
import { executeAction, executeToolCall } from "./executor";
import { GoogleApiError } from "./google/errors";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { PostgresRateLimiter, currentProjectBucket, locationEditBucket } from "./google/throttler";
import { LOCATION_OP_QUEUE, processLocationOp } from "./locationOps/jobs";
import { assertPhotoLimits, inspectImage } from "./media/image";
import { publishMediaUpload } from "./media/publish";
import { handleMediaUploadRequest } from "./media/upload-request";
import { purgeStaleMediaUploads, stageMediaUpload } from "./media/upload";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const kit = makeKit(db, mock);
const { run } = kit;

/** A PNG header (signature + IHDR) padded with zeros to `size` bytes. The parser reads no further. */
function png(w: number, h: number, size = 20_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}
/** SOI, an APP0 segment, then SOF0 with the size, padded to `size` bytes. */
function jpeg(w: number, h: number, size = 20_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  b.set([0xff, 0xc0, 0, 17, 8], 20);
  const v = new DataView(b.buffer);
  v.setUint16(25, h);
  v.setUint16(27, w);
  return b;
}
const text = (s: string) => new TextEncoder().encode(s.padEnd(20_000, " "));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const opRow = async (id: string) =>
  (await db.select().from(locationWriteOps).where(eq(locationWriteOps.id, id)))[0]!;
const upRow = async (id: string) =>
  (await db.select().from(mediaUploads).where(eq(mediaUploads.id, id)))[0]!;
const runOp = (id: string, extra: { isFinalAttempt?: boolean } = {}) =>
  processLocationOp(db, { opId: id }, { client, ...extra });
const calls = (m: string) => mock.calls.filter((c) => c.method === m);
const jobsFor = async (opId: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${LOCATION_OP_QUEUE} and data->>'opId' = ${opId}`
  ).length;

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(LOCATION_OP_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("image validation: magic bytes, not names or content types", () => {
  it("accepts PNG and JPEG and reads the pixel size from the header", () => {
    expect(inspectImage(png(800, 600))).toMatchObject({ format: "png", width: 800, height: 600 });
    expect(inspectImage(jpeg(1024, 768))).toMatchObject({
      format: "jpeg",
      contentType: "image/jpeg",
      width: 1024,
      height: 768,
    });
  });

  it.each([
    ["GIF", Uint8Array.from([...Buffer.from("GIF89a"), ...new Array(20_000).fill(0)])],
    [
      "HEIC",
      Uint8Array.from([0, 0, 0, 24, ...Buffer.from("ftypheic"), ...new Array(20_000).fill(0)]),
    ],
    [
      "WebP",
      Uint8Array.from([...Buffer.from("RIFF\0\0\0\0WEBPVP8 "), ...new Array(20_000).fill(0)]),
    ],
    ["a text file renamed .jpg", text("this is not an image")],
    ["empty", new Uint8Array()],
    ["a truncated JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
    [
      "a PNG without IHDR",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)]),
    ],
  ])("rejects %s", (_n, bytes) => {
    expect(() => inspectImage(bytes)).toThrow(/JPG and PNG|valid/);
  });

  it("enforces the byte and pixel limits from config, except the minimums for COVER and PROFILE", () => {
    const p = MEDIA_LIMITS.photo;
    const ok = inspectImage(png(400, 300));
    expect(() => assertPhotoLimits(ok, p.maxBytes, "EXTERIOR")).not.toThrow();
    expect(() => assertPhotoLimits(ok, p.maxBytes + 1, "EXTERIOR")).toThrow(/larger/);
    expect(() => assertPhotoLimits(ok, p.minBytes - 1, "EXTERIOR")).toThrow(/smaller/);
    expect(() => assertPhotoLimits(ok, p.minBytes, "EXTERIOR")).not.toThrow();
    const thin = inspectImage(png(249, 900));
    expect(() => assertPhotoLimits(thin, 20_000, "INTERIOR")).toThrow(/short edge/);
    expect(() => assertPhotoLimits(inspectImage(png(250, 900)), 20_000, "INTERIOR")).not.toThrow();
    for (const c of ["COVER", "PROFILE"]) {
      expect(() => assertPhotoLimits(thin, 2_000, c)).not.toThrow();
    }
    expect(() => assertPhotoLimits(thin, p.maxBytes + 1, "COVER")).toThrow(/larger/);
  });
});

describe("stageMediaUpload: authorization, validation, one transaction", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const stage = (actor = org.manager, file = png(800, 600), category = "EXTERIOR", l = loc) =>
    stageMediaUpload(db, actor, {
      locationId: l.row.id,
      category,
      file: { filename: "../../DCIM/IMG_0001 front.png", bytes: file },
    });

  it("stores the row, a pending op and a job; nothing goes to Google; audit has no bytes or filename", async () => {
    const before = mock.callCount;
    const bytes = png(800, 600);
    const s = await stage(org.manager, bytes);
    expect(mock.callCount).toBe(before);
    expect(s.operation).toMatchObject({
      status: "pending",
      kind: "add",
      domain: "media",
      payload: { uploadId: s.uploadId, category: "EXTERIOR" },
    });
    expect(await jobsFor(s.operation.id)).toBe(1);
    const up = await upRow(s.uploadId);
    expect(up).toMatchObject({
      status: "pending",
      contentType: "image/png",
      byteSize: bytes.length,
      sha256: sha(bytes),
      width: 800,
      height: 600,
      filename: "IMG_0001 front.png",
      createdBy: org.manager.userId,
    });
    expect(Buffer.compare(up.bytes!, Buffer.from(bytes))).toBe(0);
    const audits = await kit.auditRows(org.orgId, "media.upload_requested");
    const a = audits.find((r) => r.entityId === s.operation.id)!;
    expect(a.after).toMatchObject({
      sha256: sha(bytes),
      byteSize: bytes.length,
      category: "EXTERIOR",
      filenameHash: sha(new TextEncoder().encode("IMG_0001 front.png")),
    });
    const dump = JSON.stringify(audits.map((r) => r.after));
    expect(dump).not.toContain("IMG_0001");
    expect(dump).not.toContain("iVBOR"); // base64 of a PNG signature
  });

  it("client roles are FORBIDDEN; another workspace's client and another org get NOT_FOUND", async () => {
    expect(await codeOf(stage(org.viewerA))).toBe("FORBIDDEN");
    expect(await codeOf(stage(org.approverA))).toBe("FORBIDDEN");
    expect(await codeOf(stage(org.approverB))).toBe("NOT_FOUND");
    const stranger = await kit.makeOrg();
    expect(await codeOf(stage(stranger.owner))).toBe("NOT_FOUND");
    const rows = await db
      .select()
      .from(mediaUploads)
      .where(eq(mediaUploads.locationId, loc.row.id));
    expect(rows.every((r) => r.createdBy === org.manager.userId)).toBe(true);
  });

  it("rejects bad bytes, unknown categories and inactive locations without leaving rows or jobs", async () => {
    const count = async () =>
      (await db.select().from(mediaUploads).where(eq(mediaUploads.locationId, loc.row.id))).length;
    const n = await count();
    expect(await codeOf(stage(org.manager, text("hello")))).toBe("INVALID_INPUT");
    expect(await codeOf(stage(org.manager, png(100, 100)))).toBe("INVALID_INPUT"); // short edge
    expect(await codeOf(stage(org.manager, png(800, 600), "LOGO"))).toBe("INVALID_INPUT");
    expect(await codeOf(stage(org.manager, png(800, 600, MEDIA_LIMITS.photo.maxBytes + 1)))).toBe(
      "INVALID_INPUT",
    );
    expect(await count()).toBe(n);
    const small = await stage(org.manager, png(100, 100, 2_000), "PROFILE"); // minimums skipped
    expect(small.operation.status).toBe("pending");
  });
});

describe("the location-op job uploads through the guarded module", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const stage = (category: string, l = loc, bytes = jpeg(1200, 900)) =>
    stageMediaUpload(db, org.manager, {
      locationId: l.row.id,
      category,
      file: { filename: "front.jpg", bytes },
    });

  it("startUpload -> upload -> create(dataRef) in order, one location-edit slot, bytes purged, op applied", async () => {
    const bytes = jpeg(1200, 900);
    const s = await stage("EXTERIOR", loc, bytes);
    const mark = mock.calls.length;
    const spy = vi.spyOn(PostgresRateLimiter.prototype, "acquire");
    expect(await runOp(s.operation.id)).toBe("applied");
    const acquired = spy.mock.calls.slice();
    spy.mockRestore();

    const seq = mock.calls.slice(mark).map((c) => c.method);
    expect(seq).toEqual(["startMediaUpload", "uploadMediaBytes", "createMedia"]);
    const [start, upload, create] = mock.calls.slice(mark);
    expect(start!.args[0]).toBe(loc.parent);
    const ref = upload!.args[0] as { resourceName: string };
    expect(upload!.args[1]).toEqual({ byteLength: bytes.length, contentType: "image/jpeg" });
    expect(create!.args[1]).toMatchObject({
      mediaFormat: "PHOTO",
      locationAssociation: { category: "EXTERIOR" },
      dataRef: ref,
    });
    expect(create!.args[1]).not.toHaveProperty("sourceUrl");
    // one edit-bucket + project slot for the whole upload (a retry would re-acquire)
    expect(acquired.map((c) => c[0])).toEqual([
      locationEditBucket(loc.google),
      currentProjectBucket(),
    ]);

    const op = await opRow(s.operation.id);
    expect(op).toMatchObject({ status: "applied", error: null });
    expect(op.result).toMatchObject({ name: expect.stringContaining(`${loc.parent}/media/`) });
    const up = await upRow(s.uploadId);
    expect(up).toMatchObject({ status: "uploaded", bytes: null });
    expect(up.purgedAt).not.toBeNull();

    const listed = await run<{ items: { category: string; googleUrl: string | null }[] }>(
      org.owner,
      "media.list",
      { locationId: loc.row.id },
    );
    expect(listed.items.find((i) => i.category === "EXTERIOR")?.googleUrl).toContain("lh3.");
    const done = await kit.auditRows(org.orgId, "media.op_applied");
    expect(done.find((r) => r.entityId === s.operation.id)?.after).toMatchObject({
      uploadId: s.uploadId,
    });

    const n = calls("createMedia").length;
    expect(await runOp(s.operation.id)).toBe("ignored"); // already settled
    expect(calls("createMedia").length).toBe(n);
  });

  it("a re-run after Google applied the upload but the settle was lost creates nothing twice", async () => {
    const s = await stage("INTERIOR");
    const up = await upRow(s.uploadId);
    const first = await publishMediaUpload(
      client,
      { orgId: org.orgId, opId: s.operation.id, parent: loc.parent },
      {
        bytes: new Uint8Array(up.bytes!),
        contentType: up.contentType,
        sha256: up.sha256,
        category: "INTERIOR",
      },
    );
    const creates = calls("createMedia").length;
    const starts = calls("startMediaUpload").length;
    expect(await runOp(s.operation.id)).toBe("applied");
    expect(calls("createMedia").length).toBe(creates);
    expect(calls("startMediaUpload").length).toBe(starts);
    expect((await opRow(s.operation.id)).result).toEqual({ name: first.name });
    expect((await upRow(s.uploadId)).bytes).toBeNull();
  });

  it("a Google rejection fails the op, keeps the bytes and marks the upload failed; a purged upload fails as upload_expired", async () => {
    const loc2 = await org.mkLoc(org.a);
    const s = await stage("TEAMS", loc2);
    mock.failNext(
      1,
      () => new GoogleApiError(400, { error: { message: "bad image BODYTEXT" } }),
      "createMedia",
    );
    expect(await runOp(s.operation.id)).toBe("failed");
    expect(await opRow(s.operation.id)).toMatchObject({
      status: "failed",
      error: "google_http_400",
    });
    const up = await upRow(s.uploadId);
    expect(up.status).toBe("failed");
    expect(up.bytes).not.toBeNull();
    const failed = await kit.auditRows(org.orgId, "media.op_failed");
    expect(JSON.stringify(failed.map((f) => f.after))).not.toContain("BODYTEXT");

    const s2 = await stage("TEAMS", loc2);
    await db.update(mediaUploads).set({ bytes: null }).where(eq(mediaUploads.id, s2.uploadId));
    const n = mock.callCount;
    expect(await runOp(s2.operation.id)).toBe("failed");
    expect((await opRow(s2.operation.id)).error).toBe("upload_expired");
    expect(mock.callCount).toBe(n);
  });

  it("an unexpected error retries (pending, bytes kept); the final attempt fails it", async () => {
    const loc3 = await org.mkLoc(org.a);
    const s = await stage("PRODUCT", loc3);
    mock.failNext(2, () => new Error("socket hang up"), "uploadMediaBytes");
    await expect(runOp(s.operation.id)).rejects.toThrow("socket hang up");
    expect((await opRow(s.operation.id)).status).toBe("pending");
    expect((await upRow(s.uploadId)).bytes).not.toBeNull();
    expect(await runOp(s.operation.id, { isFinalAttempt: true })).toBe("failed");
    expect((await upRow(s.uploadId)).status).toBe("failed");
  });

  it("failed uploads lose their bytes after the retention window; recent ones and uploaded ones are untouched", async () => {
    const loc4 = await org.mkLoc(org.a);
    const old = await stage("ADDITIONAL", loc4);
    const recent = await stage("ADDITIONAL", loc4);
    const day = 86_400_000;
    const age = (id: string, days: number) =>
      db
        .update(mediaUploads)
        .set({ status: "failed", createdAt: new Date(Date.now() - days * day) })
        .where(eq(mediaUploads.id, id));
    await age(old.uploadId, MEDIA_LIMITS.upload.failedRetentionDays + 1);
    await age(recent.uploadId, MEDIA_LIMITS.upload.failedRetentionDays - 1);
    const r = await purgeStaleMediaUploads(db);
    expect(r.uploads).toBeGreaterThanOrEqual(1);
    expect(await upRow(old.uploadId)).toMatchObject({ status: "purged", bytes: null });
    expect((await upRow(old.uploadId)).purgedAt).not.toBeNull();
    expect((await upRow(recent.uploadId)).bytes).not.toBeNull();
    expect(await purgeStaleMediaUploads(db)).toMatchObject({ uploads: 0 }); // idempotent
  });
});

describe("media.upload over MCP (base64, two-phase) and the UI action", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
    await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, org.ownerId));
  });
  const input = (bytes: Uint8Array, extra: Record<string, unknown> = {}) => ({
    locationId: loc.row.id,
    category: "COVER",
    filename: "cover.png",
    contentBase64: b64(bytes),
    ...extra,
  });

  it("a token call returns a proposal whose preview has file facts but no image; apply stages the op; the input is scrubbed after expiry", async () => {
    const email = `${org.ownerId}@example.test`;
    const { token } = await createApiToken(db, { email, mode: "full_autonomy" });
    const actor = await verifyApiToken(db, token);
    const bytes = png(1080, 608);
    const p = (await executeToolCall(db, actor, "media.upload", input(bytes))) as {
      proposalId: string;
      preview: { summary: string; diff: unknown };
    };
    expect(p.preview.summary).toContain("cover.png");
    expect(p.preview.summary).toContain("1080x608");
    expect(JSON.stringify(p.preview)).not.toContain(b64(bytes).slice(0, 40));
    expect(await jobsCount(loc)).toBe(0); // proposing writes no op

    // Q33d: a photo goes to Google, so even a full-autonomy token cannot apply it; the owner does in the app.
    const refused = await executeToolCall(db, actor, "mcp.proposals.apply", { proposalId: p.proposalId }).catch((e) => e as Error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("A person must approve this in OpenGMB");
    expect((await jobsCount(loc))).toBe(0);
    const web = await loadActor(db, { userId: org.ownerId, surface: "ui", actorType: "user" });
    const applied = (await executeAction(db, web, "mcp.proposals.apply", {
      proposalId: p.proposalId,
    })) as {
      status: string;
      result: { operation: { id: string; status: string }; uploadId: string };
    };
    expect(applied.status).toBe("applied");
    const { operation, uploadId } = applied.result;
    expect(operation.status).toBe("pending");
    expect((await upRow(uploadId)).byteSize).toBe(bytes.length);
    expect(await jobsFor(operation.id)).toBe(1);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, operation.id));
    expect(audit.map((a) => a.action)).toContain("media.upload_requested");
    expect(audit.find((a) => a.action === "media.upload_requested")!.surface).toBe("ui");

    // the stored proposal input holds the base64 until it expires, then the nightly purge scrubs it
    const [row] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(JSON.stringify(row!.input)).toContain(b64(bytes).slice(0, 40));
    await db
      .update(mcpProposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpProposals.id, p.proposalId));
    expect((await purgeStaleMediaUploads(db)).proposals).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(mcpProposals).where(eq(mcpProposals.id, p.proposalId));
    expect(after!.input).toEqual({ purged: true });

    expect(await runOp(operation.id)).toBe("applied");
  });

  it("a proposal for a bad file fails at propose time; bad base64 and oversize input are INVALID_INPUT", async () => {
    const email = `${org.ownerId}@example.test`;
    const actor = await verifyApiToken(db, (await createApiToken(db, { email, mode: "full_autonomy" })).token);
    expect(await codeOf(executeToolCall(db, actor, "media.upload", input(text("nope"))))).toBe(
      "INVALID_INPUT",
    );
    expect(
      await codeOf(
        executeAction(
          db,
          org.manager,
          "media.upload",
          input(png(800, 600), { contentBase64: "!!!!" }),
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        executeAction(
          db,
          org.manager,
          "media.upload",
          input(png(800, 600), {
            contentBase64: "A".repeat(MEDIA_LIMITS.upload.maxBase64Chars + 4),
          }),
        ),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("the UI action path needs profile:edit like the route does", async () => {
    const ok = (await executeAction(db, org.manager, "media.upload", input(png(1080, 608)))) as {
      operation: { status: string };
    };
    expect(ok.operation.status).toBe("pending");
    expect(
      await codeOf(executeAction(db, org.viewerA, "media.upload", input(png(1080, 608)))),
    ).toBe("FORBIDDEN");
  });
});

type J = { error: { code: string }; uploadId: string };
const jobsCount = async (l: Loc) =>
  (await db.select().from(locationWriteOps).where(eq(locationWriteOps.locationId, l.row.id)))
    .length;

describe("POST /api/media/upload handler", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const now = Date.now();
  const session = (userId: string, twoFactorEnabled: boolean) => ({
    session: { createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000) },
    user: { id: userId, email: `${userId}@example.test`, twoFactorEnabled },
  });
  const req = (bytes: Uint8Array | null, fields: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("locationId", fields.locationId ?? loc.row.id);
    f.set("category", fields.category ?? "EXTERIOR");
    if (bytes) f.set("file", new File([bytes as unknown as Blob], "p.png", { type: "image/png" }));
    return new Request("http://localhost/api/media/upload", { method: "POST", body: f });
  };
  const call = (r: Request, s: ReturnType<typeof session> | null) =>
    handleMediaUploadRequest(r, { db, getSession: async () => s });
  const rowsFor = async () =>
    (await db.select().from(mediaUploads).where(eq(mediaUploads.locationId, loc.row.id))).length;

  it("rejects no session (401) and a session without MFA (403) before reading the file or touching the database", async () => {
    const n = await rowsFor();
    const none = await call(req(png(800, 600)), null);
    expect(none.status).toBe(401);
    expect(((await none.json()) as J).error.code).toBe("UNAUTHENTICATED");
    const noMfa = await call(req(png(800, 600)), session(org.ownerId, false));
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as J).error.code).toBe("MFA_REQUIRED");
    expect(await rowsFor()).toBe(n);
  });

  it("stages the photo for an authorized, MFA-enrolled user (202) and maps core errors to statuses", async () => {
    const ok = await call(req(png(800, 600)), session(org.ownerId, true));
    expect(ok.status).toBe(202);
    const body = (await ok.json()) as J;
    expect(body).toMatchObject({ ok: true, operation: { status: "pending", kind: "add" } });
    expect((await upRow(body.uploadId)).byteSize).toBe(20_000);

    expect((await call(req(text("x")), session(org.ownerId, true))).status).toBe(400);
    expect((await call(req(null), session(org.ownerId, true))).status).toBe(400);
    expect(
      (await call(req(png(800, 600), { locationId: "nope" }), session(org.ownerId, true))).status,
    ).toBe(400);
    const stranger = await kit.makeOrg();
    expect((await call(req(png(800, 600)), session(stranger.ownerId, true))).status).toBe(404);
    const viewer = org.viewerA.userId;
    expect((await call(req(png(800, 600)), session(viewer, true))).status).toBe(403);
    const big = new Request("http://localhost/api/media/upload", {
      method: "POST",
      headers: { "content-length": String(MEDIA_LIMITS.photo.maxBytes * 2) },
      body: new FormData(),
    });
    expect((await call(big, session(org.ownerId, true))).status).toBe(413);
  });
});
