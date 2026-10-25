import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, mediaUploads, reportDefinitions, reportRuns, storedFiles } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { createPostImage } from "./postImages/store";
import { eraseWorkspace } from "./privacy/engine";
import { handleFileGet } from "./storage/serve";
import { deleteLogo, getStoredFileFor, orgUsage, putStoredFile, sniffStoredFileType, StorageQuotaError } from "./storage/store";
import { handleLogoUpload, uploadLogo } from "./storage/logo";
import { STORED_FILE_MAX_BYTES, storageQuotaBytes } from "./config/storage-limits";
import { codeOf, makeKit, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());

/** A PNG-looking buffer: signature, IHDR, then filler. `seed` makes the bytes (and sha256) differ. */
function png(size = 2_000, seed = 0): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, 64);
  v.setUint32(20, 64);
  for (let i = 24; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const webp = () => {
  const b = new Uint8Array(40);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
};

let org: Org;
let other: Org;
beforeAll(async () => {
  org = await kit.makeOrg();
  other = await kit.makeOrg();
});
afterEach(() => {
  delete process.env.STORAGE_QUOTA_MB;
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

const put = (o: Org, workspaceId: string | null, bytes: Uint8Array, actor = o.owner) =>
  db.transaction((tx) => putStoredFile(tx, actor, { kind: "logo", workspaceId, bytes }));

describe("file store", () => {
  it("stores a logo and reads it back through a brand new connection", async () => {
    const bytes = png(3_000, 1);
    const row = await put(org, null, bytes);
    expect(row.contentType).toBe("image/png");
    expect(row.byteSize).toBe(3_000);
    expect(row).not.toHaveProperty("bytes");
    // "restart": a second pool that shares nothing with the first
    const fresh = createDb(url);
    try {
      const [back] = await fresh.db.select().from(storedFiles).where(eq(storedFiles.id, row.id));
      expect(back!.bytes.equals(Buffer.from(bytes))).toBe(true);
      const got = await getStoredFileFor(fresh.db, org.owner, row.id);
      expect(got!.contentType).toBe("image/png");
      expect(got!.bytes.equals(Buffer.from(bytes))).toBe(true);
    } finally {
      await fresh.sql.end();
    }
  });

  it("accepts PNG, JPEG and WebP and refuses SVG, GIF and a renamed text file", () => {
    expect(sniffStoredFileType(png())).toBe("image/png");
    expect(sniffStoredFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 4, 0, 4, 1, 1, 0x11, 0])) ).toBe("image/jpeg");
    expect(sniffStoredFileType(webp())).toBe("image/webp");
    for (const bad of [svg(), new TextEncoder().encode("GIF89a".padEnd(40, " ")), new TextEncoder().encode("hello world, not an image at all")]) {
      expect(() => sniffStoredFileType(bad)).toThrow(/PNG, JPG and WebP/);
    }
  });

  it("refuses a wrong content type, an empty file and a file over the per-file cap", async () => {
    expect(await codeOf(put(org, null, svg()))).toBe("INVALID_INPUT");
    expect(await codeOf(put(org, null, new Uint8Array(0)))).toBe("INVALID_INPUT");
    const cap = STORED_FILE_MAX_BYTES.logo;
    expect(await codeOf(put(org, null, png(cap + 1)))).toBe("INVALID_INPUT");
    const exact = await put(org, null, png(cap, 2));
    expect(exact.byteSize).toBe(cap);
    await deleteLogoOf(org, null);
  });

  it("dedupes the same bytes in a slot and replaces the old logo with a new one", async () => {
    const a = await put(org, org.a, png(4_000, 3));
    const again = await put(org, org.a, png(4_000, 3));
    expect(again.id).toBe(a.id);
    expect(again.deduped).toBe(true);
    const b = await put(org, org.a, png(5_000, 4));
    expect(b.id).not.toBe(a.id);
    expect(b.replacedId).toBe(a.id);
    const rows = await db.select().from(storedFiles).where(eq(storedFiles.workspaceId, org.a));
    expect(rows.map((r) => r.id)).toEqual([b.id]);
    await deleteLogoOf(org, org.a);
  });

  it("refuses a workspace of another organization", async () => {
    expect(await codeOf(put(org, other.a, png()))).toBe("NOT_FOUND");
  });
});

const deleteLogoOf = (o: Org, ws: string | null) => db.transaction((tx) => deleteLogo(tx, o.orgId, ws));

describe("quota", () => {
  it("allows exactly the limit and refuses one byte more, naming used and limit", async () => {
    process.env.STORAGE_QUOTA_MB = "1";
    const limit = storageQuotaBytes();
    expect(limit).toBe(1024 * 1024);
    const q = await kit.makeOrg();
    await put(q, q.a, png(1_000_000, 5));
    await put(q, q.b, png(limit - 1_000_000, 6)); // total is exactly the limit
    expect((await orgUsage(db, q.orgId)).usedBytes).toBe(limit);
    const err = await put(q, null, png(100, 7)).catch((e) => e);
    expect(err).toBeInstanceOf(StorageQuotaError);
    expect(err.usedBytes).toBe(limit);
    expect(err.limitBytes).toBe(limit);
    expect(err.message).toContain("1.0 MB of 1.0 MB");
    // replacing a logo frees the old one first: a same-size swap fits, a bigger one does not
    await put(q, q.a, png(1_000_000, 8));
    expect(await codeOf(put(q, q.a, png(1_000_001, 9)))).toBe("CONFLICT");
    // refused uploads left nothing behind
    expect((await orgUsage(db, q.orgId)).usedBytes).toBe(limit);
  });

  it("is per organization: another organization's files do not count", async () => {
    process.env.STORAGE_QUOTA_MB = "1";
    const q = await kit.makeOrg();
    const r = await kit.makeOrg();
    await put(q, null, png(1_000_000, 10));
    expect(await put(r, null, png(1_000_000, 11))).toBeTruthy();
  });

  it("counts the older binary stores: post images, staged photo uploads and report PDFs", async () => {
    const q = await kit.makeOrg();
    const loc = await q.mkLoc(q.a);
    await put(q, null, png(1_000, 12));
    await createPostImage(db, q.manager, { workspaceId: q.a, filename: "a.png", bytes: png(20_000, 13) });
    await db.insert(mediaUploads).values({
      orgId: q.orgId, locationId: loc.row.id, createdBy: q.ownerId, filename: "p.png", contentType: "image/png",
      byteSize: 30_000, sha256: "x", width: 64, height: 64, bytes: Buffer.alloc(30_000), status: "pending",
    });
    // a purged upload (bytes gone) must not count
    await db.insert(mediaUploads).values({
      orgId: q.orgId, locationId: loc.row.id, createdBy: q.ownerId, filename: "q.png", contentType: "image/png",
      byteSize: 99_000, sha256: "y", width: 64, height: 64, bytes: null, status: "purged",
    });
    const [def] = await db.insert(reportDefinitions).values({
      orgId: q.orgId, workspaceId: q.a, name: "R", scope: "workspace", period: "last_month", createdBy: q.ownerId,
    }).returning();
    await db.insert(reportRuns).values({
      orgId: q.orgId, definitionId: def!.id, periodStart: "2026-09-01", periodEnd: "2026-09-30",
      status: "done", pdf: Buffer.alloc(40_000), pdfBytes: 40_000,
    });
    const u = await orgUsage(db, q.orgId);
    expect(u.breakdown).toEqual({ storedFiles: 1_000, postImages: 20_000, mediaUploads: 30_000, reportPdfs: 40_000 });
    expect(u.usedBytes).toBe(91_000);
    expect(u.limitBytes).toBe(50 * 1024 * 1024);
  });

  it("refuses a post image upload that would pass the limit", async () => {
    process.env.STORAGE_QUOTA_MB = "1";
    const q = await kit.makeOrg();
    await put(q, null, png(1_040_000, 14));
    const err = await createPostImage(db, q.manager, { workspaceId: q.a, filename: "a.png", bytes: png(20_000, 15) }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageQuotaError);
  });

  it("STORAGE_QUOTA_MB falls back to 50 MB when it is not a positive number", () => {
    expect(storageQuotaBytes({ STORAGE_QUOTA_MB: "abc" } as never)).toBe(50 * 1024 * 1024);
    expect(storageQuotaBytes({ STORAGE_QUOTA_MB: "-5" } as never)).toBe(50 * 1024 * 1024);
    expect(storageQuotaBytes({ STORAGE_QUOTA_MB: "100" } as never)).toBe(100 * 1024 * 1024);
  });
});

describe("tenant isolation and serving", () => {
  it("another organization cannot read a file, and a client sees only its own client's logo", async () => {
    const orgLogo = await put(org, null, png(1_000, 20));
    const logoA = await put(org, org.a, png(1_000, 21));
    const logoB = await put(org, org.b, png(1_000, 22));
    expect(await getStoredFileFor(db, other.owner, logoA.id)).toBeNull();
    expect(await getStoredFileFor(db, other.owner, orgLogo.id)).toBeNull();
    expect(await getStoredFileFor(db, org.approverA, logoA.id)).not.toBeNull();
    expect(await getStoredFileFor(db, org.viewerA, logoA.id)).not.toBeNull();
    expect(await getStoredFileFor(db, org.approverA, logoB.id)).toBeNull();
    expect(await getStoredFileFor(db, org.approverA, orgLogo.id)).not.toBeNull(); // the agency's own logo
    expect(await getStoredFileFor(db, org.owner, logoB.id)).not.toBeNull();
    expect(await getStoredFileFor(db, org.owner, "not-a-uuid")).toBeNull();
  });

  it("the route serves the right headers, 404s for a stranger and 401s without a session", async () => {
    const f = await put(org, org.a, png(1_500, 23));
    const ok = await handleFileGet(f.id, { db, getSession: async () => session(org.ownerId, true) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toContain("immutable");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await ok.arrayBuffer()).byteLength).toBe(1_500);
    expect((await handleFileGet(f.id, { db, getSession: async () => session(org.approverB.userId, true) })).status).toBe(404);
    expect((await handleFileGet(f.id, { db, getSession: async () => session(other.ownerId, true) })).status).toBe(404);
    expect((await handleFileGet(f.id, { db, getSession: async () => null })).status).toBe(401);
    expect((await handleFileGet(f.id, { db, getSession: async () => session(org.ownerId, false) })).status).toBe(403);
  });
});

const now = Date.now();
const session = (userId: string, twoFactorEnabled: boolean) =>
  ({
    session: { createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000) },
    user: { id: userId, email: "t@example.test", twoFactorEnabled },
  }) as never;

describe("upload, remove and erase", () => {
  it("only owners and admins upload; a manager and a client cannot", async () => {
    expect(await codeOf(uploadLogo(db, org.manager, { workspaceId: null, bytes: png(1_000, 30) }))).toBe("FORBIDDEN");
    expect(await codeOf(uploadLogo(db, org.approverA, { workspaceId: org.a, bytes: png(1_000, 31) }))).toBe("FORBIDDEN");
    const row = await uploadLogo(db, org.owner, { workspaceId: null, bytes: png(1_000, 32) });
    expect(row.byteSize).toBe(1_000);
    expect((await kit.auditRows(org.orgId, "storage.logo_uploaded")).length).toBeGreaterThan(0);
    const remove = (actor: Org["owner"], input: object) => kit.run<{ removed: boolean }>(actor, "branding.removeLogo", input);
    expect((await remove(org.owner, {})).removed).toBe(true);
    expect((await remove(org.owner, {})).removed).toBe(false);
    expect(await codeOf(remove(org.owner, { workspaceId: other.a }))).toBe("NOT_FOUND");
    expect(await codeOf(remove(org.manager, {}))).toBe("FORBIDDEN");
    const logos = await kit.run<{ orgLogoFileId: string | null; workspaceLogos: { workspaceId: string }[] }>(org.approverA, "branding.logos");
    expect(logos.workspaceLogos.every((l) => l.workspaceId === org.a)).toBe(true);
    const usage = await kit.run<{ usedBytes: number; limitBytes: number }>(org.owner, "storage.usage");
    expect(usage.limitBytes).toBe(50 * 1024 * 1024);
    expect(await codeOf(kit.run(org.manager, "storage.usage"))).toBe("FORBIDDEN");
  });

  it("the upload route: 401 and 403 first, 201 for an owner, 413 over the cap, 400 for SVG, 413 over quota", async () => {
    const req = (bytes: Uint8Array, ws?: string, length?: number) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" }));
      if (ws) form.set("workspaceId", ws);
      return new Request("http://x/api/files/logo", {
        method: "POST",
        body: form,
        ...(length ? { headers: { "content-length": String(length) } } : {}),
      });
    };
    const call = (r: Request, userId: string | null, mfa = true) =>
      handleLogoUpload(r, { db, getSession: async () => (userId ? session(userId, mfa) : null) });
    expect((await call(req(png()), null)).status).toBe(401);
    expect((await call(req(png()), org.ownerId, false)).status).toBe(403);
    const ok = await call(req(png(1_200, 50), org.a), org.ownerId);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { file: { byteSize: number } }).file.byteSize).toBe(1_200);
    expect((await call(req(png(1_200, 51), org.a), org.manager.userId)).status).toBe(403);
    expect((await call(req(png(STORED_FILE_MAX_BYTES.logo + 1, 52)), org.ownerId)).status).toBe(413);
    expect((await call(req(png(), undefined, STORED_FILE_MAX_BYTES.logo + 200_000), org.ownerId)).status).toBe(413);
    expect((await call(req(svg()), org.ownerId)).status).toBe(400);
    process.env.STORAGE_QUOTA_MB = "1";
    const q = await kit.makeOrg();
    await put(q, q.b, png(1_048_000, 53));
    const full = await call(req(png(2_000, 54), q.a), q.ownerId);
    expect(full.status).toBe(413);
    const body = (await full.json()) as { error: { message: string; usedBytes: number; limitBytes: number } };
    expect(body.error.message).toContain("1.0 MB of 1.0 MB");
    expect(body.error.limitBytes).toBe(1024 * 1024);
  });

  it("erasing a client deletes its files and keeps the agency logo and other clients", async () => {
    const e = await kit.makeOrg();
    const agency = await put(e, null, png(1_000, 40));
    await put(e, e.a, png(1_000, 41));
    const keep = await put(e, e.b, png(1_000, 42));
    await db.transaction((tx) => eraseWorkspace(tx, e.a));
    const left = await db.select({ id: storedFiles.id }).from(storedFiles).where(eq(storedFiles.orgId, e.orgId));
    expect(left.map((r) => r.id).sort()).toEqual([agency.id, keep.id].sort());
  });
});
