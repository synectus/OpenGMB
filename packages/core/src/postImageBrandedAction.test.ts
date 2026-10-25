import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, createDb, memberships, postImages, users } from "@opengmb/db";
import { handleBrandedPreview } from "./postImages/branded-preview-request";
import { createApiToken, verifyApiToken } from "./apiTokens";
import { executeToolCall } from "./executor";
import { renderBrandedImage } from "./postImages/branded";
import { MockGoogleClient } from "./google/mock-client";
import { loadBrandedInputs } from "./postImages/branded-inputs";
import { createPostImage, getPublicPostImage } from "./postImages/store";
import { fixtureLogo, fixturePhoto } from "./postImages/test-fixtures";
import { uploadLogo } from "./storage/logo";
import { codeOf, makeKit, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());

let org: Org;
beforeAll(async () => {
  process.env.BETTER_AUTH_URL = "https://app.example";
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

const addPhoto = (workspaceId: string, seed = 0) =>
  fixturePhoto(seed).then((bytes) => createPostImage(db, org.manager, { workspaceId, filename: "p.jpg", bytes }));
const load = (workspaceId: string, photoImageId: string, useLogo = true, actor = org.manager) =>
  db.transaction((tx) => loadBrandedInputs(tx, actor, { workspaceId, photoImageId, useLogo }));

describe("loadBrandedInputs", () => {
  it("loads a photo of the client's library", async () => {
    const img = await addPhoto(org.a);
    const got = await load(org.a, img.id, false);
    expect(got.photo.length).toBe(img.byteSize);
    expect(got.logo).toBeNull();
  });

  it("a photo of another client is NOT_FOUND", async () => {
    const other = await addPhoto(org.b);
    expect(await codeOf(load(org.a, other.id))).toBe("NOT_FOUND");
  });

  it("an agency logo is never used; a client logo is", async () => {
    const img = await addPhoto(org.a, 1);
    await uploadLogo(db, org.owner, { workspaceId: null, bytes: await fixtureLogo() });
    expect((await load(org.a, img.id)).logo).toBeNull();
    const logo = await fixtureLogo();
    await uploadLogo(db, org.owner, { workspaceId: org.a, bytes: logo });
    const got = await load(org.a, img.id);
    expect(got.logo).not.toBeNull();
    expect(got.logo!.length).toBe(logo.length);
    expect((await load(org.a, img.id, false)).logo).toBeNull();
  });

  it("a client_viewer is FORBIDDEN", async () => {
    const img = await addPhoto(org.a, 2);
    expect(await codeOf(load(org.a, img.id, true, org.viewerA))).toBe("FORBIDDEN");
  });
});

type Img = { id: string; url: string; name: string; width: number; height: number; byteSize: number; contentType: string };
const render = (o: { photoImageId: string; headline?: string; layout?: "band" | "frame"; subline?: string }, actor = org.manager) =>
  kit.run<{ image: Img }>(actor, "postImages.renderBranded", {
    workspaceId: org.a,
    layout: "band",
    headline: "Spring tune-up, 20% off",
    ...o,
  });
const rowsOf = (workspaceId: string) => db.select().from(postImages).where(eq(postImages.workspaceId, workspaceId));

describe("postImages.renderBranded", () => {
  it("renders into the library as a 1200x900 JPEG with a public url, byte-identical to a direct render", async () => {
    const photo = await addPhoto(org.a, 3);
    const { image } = await render({ photoImageId: photo.id, subline: "Book by 30 November" });
    expect(image).toMatchObject({ width: 1200, height: 900, contentType: "image/jpeg" });
    expect(image.name).toBe("Branded band - Spring tune-up, 20% off");
    expect(image.url).toMatch(/\/m\/[0-9a-f]{48}$/);
    const list = await kit.run<{ images: { id: string }[] }>(org.manager, "postImages.list", { workspaceId: org.a });
    expect(list.images.map((i) => i.id)).toContain(image.id);
    const token = image.url.split("/m/")[1]!;
    const stored = await getPublicPostImage(db, token);
    const direct = await renderBrandedImage({
      layout: "band",
      headline: "Spring tune-up, 20% off",
      subline: "Book by 30 November",
      photo: await db.transaction(async (tx) => (await loadBrandedInputs(tx, org.manager, { workspaceId: org.a, photoImageId: photo.id, useLogo: true })).photo),
      logo: await db.transaction(async (tx) => (await loadBrandedInputs(tx, org.manager, { workspaceId: org.a, photoImageId: photo.id, useLogo: true })).logo),
    });
    expect(Buffer.compare(Buffer.from(stored!.bytes), Buffer.from(direct.bytes))).toBe(0);
  });

  it("two runs with the same input make two rows with the same sha256", async () => {
    const photo = await addPhoto(org.a, 4);
    const before = (await rowsOf(org.a)).length;
    const a = await render({ photoImageId: photo.id, headline: "Same twice" });
    const b = await render({ photoImageId: photo.id, headline: "Same twice" });
    const rows = await rowsOf(org.a);
    expect(rows.length).toBe(before + 2);
    expect(a.image.id).not.toBe(b.image.id);
    const sha = (id: string) => rows.find((r) => r.id === id)!.sha256;
    expect(sha(a.image.id)).toBe(sha(b.image.id));
  });

  it("audits post_image.uploaded and post_image.rendered, and never the headline", async () => {
    const photo = await addPhoto(org.a, 5);
    const headline = "Secret headline 4711";
    const { image } = await render({ photoImageId: photo.id, headline });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.entityId, image.id)));
    expect(rows.map((r) => r.action).sort()).toEqual(["post_image.rendered", "post_image.uploaded"]);
    expect(JSON.stringify(rows)).not.toContain(headline);
    const rendered = rows.find((r) => r.action === "post_image.rendered")!;
    expect(rendered.after).toMatchObject({ workspaceId: org.a, sourceImageId: photo.id, layout: "band", usedLogo: expect.any(Boolean) });
  });

  it("refuses non-Latin text with INVALID_INPUT and creates nothing", async () => {
    const photo = await addPhoto(org.a, 6);
    const before = (await rowsOf(org.a)).length;
    expect(await codeOf(render({ photoImageId: photo.id, headline: "नमस्ते" }))).toBe("INVALID_INPUT");
    expect((await rowsOf(org.a)).length).toBe(before);
  });

  it("over the storage quota it is CONFLICT", async () => {
    const q = await kit.makeOrg();
    const bytes = await fixturePhoto(7);
    const photo = await createPostImage(db, q.manager, { workspaceId: q.a, filename: "p.jpg", bytes });
    // Room for the source photo plus 1 KB: the rendered image (tens of KB) cannot fit.
    process.env.STORAGE_QUOTA_MB = String((photo.byteSize + 1024) / 1024 / 1024);
    try {
      expect(
        await codeOf(
          kit.run(q.manager, "postImages.renderBranded", { workspaceId: q.a, photoImageId: photo.id, layout: "band", headline: "Over quota" }),
        ),
      ).toBe("CONFLICT");
    } finally {
      delete process.env.STORAGE_QUOTA_MB;
    }
  });

  it("over MCP it is a proposal: no post_images row until a person applies it", async () => {
    const photo = await addPhoto(org.a, 8);
    const id = `u-mcp-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${id}@example.test`;
    await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
    await db.insert(memberships).values({ orgId: org.orgId, userId: id, role: "manager" });
    const { token } = await createApiToken(db, { email, readOnly: false });
    const actor = await verifyApiToken(db, token);
    const before = (await rowsOf(org.a)).length;
    const out = (await executeToolCall(db, actor, "postImages.renderBranded", {
      workspaceId: org.a,
      photoImageId: photo.id,
      layout: "frame",
      headline: "Proposed only",
    })) as { proposalId: string };
    expect(out.proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rowsOf(org.a)).length).toBe(before);
  });
});

describe("POST /api/post-images/branded-preview handler", () => {
  const now = Date.now();
  const session = (userId: string, twoFactorEnabled = true) => ({
    session: { createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000) },
    user: { id: userId, email: `${userId}@example.test`, twoFactorEnabled },
  });
  const req = (body: unknown) =>
    new Request("http://localhost/api/post-images/branded-preview", { method: "POST", body: JSON.stringify(body) });
  const call = (r: Request, s: ReturnType<typeof session> | null) =>
    handleBrandedPreview(r, { db, getSession: async () => s });
  const body = (photoImageId: string, extra: object = {}) => ({
    workspaceId: org.a,
    photoImageId,
    layout: "band",
    headline: "Preview me",
    ...extra,
  });

  it("401 without a session, 403 for a client_viewer, 400 for a bad layout, 400 for non-Latin text", async () => {
    const photo = await addPhoto(org.a, 9);
    const viewer = { id: org.viewerA.userId };
    expect((await call(req(body(photo.id)), null)).status).toBe(401);
    expect((await call(req(body(photo.id)), session(viewer.id))).status).toBe(403);
    expect((await call(req(body(photo.id, { layout: "circle" })), session(org.ownerId))).status).toBe(400);
    expect((await call(req(body(photo.id, { headline: "你好" })), session(org.ownerId))).status).toBe(400);
  });

  it("200 with a JPEG, the right headers, and no new post_images row or audit row", async () => {
    const photo = await addPhoto(org.a, 10);
    const rowsBefore = (await rowsOf(org.a)).length;
    const auditBefore = (await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId))).length;
    const res = await call(req(body(photo.id, { subline: "Book now" })), session(org.ownerId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect((await rowsOf(org.a)).length).toBe(rowsBefore);
    expect((await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId))).length).toBe(auditBefore);
  });

  it("413 for a body over 8 KB", async () => {
    const photo = await addPhoto(org.a, 11);
    const res = await call(req(body(photo.id, { subline: "x".repeat(9000) })), session(org.ownerId));
    expect(res.status).toBe(413);
  });
});
