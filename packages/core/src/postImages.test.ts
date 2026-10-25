import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, createDb, postImages, posts } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, type Org } from "./testkit";
import {
  BLOCKING_POST_STATUSES,
  createPostImage,
  getPublicPostImage,
  publicPostImageUrl,
  tokensIn,
} from "./postImages/store";
import { handlePostImageUpload } from "./postImages/upload-request";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

function png(w: number, h: number, size = 20_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}
const gif = () => new TextEncoder().encode("GIF89a".padEnd(20_000, " "));
const BASE = "https://app.example";

let org: Org;
beforeAll(async () => {
  process.env.BETTER_AUTH_URL = BASE;
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

const upload = (name = "front desk.PNG", bytes = png(800, 600), workspaceId = org.a) =>
  createPostImage(db, org.manager, { workspaceId, filename: name, bytes });

const addPost = async (media: { sourceUrl: string }[], status: (typeof posts.$inferInsert)["status"]) => {
  const [p] = await db
    .insert(posts)
    .values({
      orgId: org.orgId,
      workspaceId: org.a,
      createdBy: org.ownerId,
      createdSurface: "ui",
      topicType: "STANDARD",
      summary: "Our Saturday clinic is back\nsecond line",
      media,
      status,
    })
    .returning();
  return p!;
};

describe("tokensIn", () => {
  it("finds library tokens in a post's media and ignores other URLs", () => {
    const t = "a".repeat(48);
    expect(tokensIn([{ sourceUrl: `https://x.example/m/${t}` }, { sourceUrl: "https://y.example/a.png" }])).toEqual([t]);
    expect(tokensIn(null)).toEqual([]);
    expect(tokensIn([{ sourceUrl: "https://x.example/m/short" }])).toEqual([]);
  });
});

describe("create and read", () => {
  it("stores the bytes, a 48-hex token and a cleaned name, audits without the name", async () => {
    const img = await upload("C:\\fakepath\\front desk.PNG");
    expect(img.token).toMatch(/^[0-9a-f]{48}$/);
    expect(img.name).toBe("front desk.PNG");
    expect(img).toMatchObject({ contentType: "image/png", width: 800, height: 600, byteSize: 20_000 });
    expect(publicPostImageUrl(img.token)).toBe(`${BASE}/m/${img.token}`);
    const got = await getPublicPostImage(db, img.token);
    expect(got?.contentType).toBe("image/png");
    expect(got?.bytes.length).toBe(20_000);
    expect(await getPublicPostImage(db, "z".repeat(48))).toBeNull();
    expect(await getPublicPostImage(db, "../etc")).toBeNull();
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "post_image.uploaded")));
    expect(JSON.stringify(rows.map((r) => r.after))).not.toContain("front desk");
  });

  it("refuses GIF, an image over 5 MB, and a role without review:draft", async () => {
    expect(await codeOf(upload("a.gif", gif()))).toBe("INVALID_INPUT");
    expect(await codeOf(upload("big.png", png(800, 600, 5 * 1024 * 1024 + 1)))).toBe("INVALID_INPUT");
    expect(
      await codeOf(createPostImage(db, org.approverA, { workspaceId: org.a, filename: "a.png", bytes: png(800, 600) })),
    ).toBe("FORBIDDEN");
  });
});

describe("postImages.list, rename, delete", () => {
  it("lists usage and templates, hides bytes, and reports can.manage by role", async () => {
    const img = await upload("used.png");
    await addPost([{ sourceUrl: publicPostImageUrl(img.token) }], "approved");
    await addPost([{ sourceUrl: publicPostImageUrl(img.token) }], "cancelled");
    const r = await run<{ images: { id: string; usedIn: { status: string; title: string }[]; canDelete: boolean; deleteBlockedBy: string | null; url: string }[]; can: { manage: boolean } }>(
      org.manager, "postImages.list", { workspaceId: org.a });
    const row = r.images.find((i) => i.id === img.id)!;
    expect(row.usedIn.map((u) => u.status).sort()).toEqual(["approved", "cancelled"]);
    expect(row.usedIn[0]!.title).toBe("Our Saturday clinic is back");
    expect(row.canDelete).toBe(false);
    expect(row.deleteBlockedBy).toBe("scheduled");
    expect(row.url).toBe(publicPostImageUrl(img.token));
    expect(JSON.stringify(r)).not.toContain("bytes");
    expect(r.can.manage).toBe(true);
    const v = await run<{ can: { manage: boolean } }>(org.viewerA, "postImages.list", { workspaceId: org.a });
    expect(v.can.manage).toBe(false);
  });

  it("blocks delete while a pending, approved, scheduled or publishing post uses it, allows drafts, and refuses MCP", async () => {
    expect([...BLOCKING_POST_STATUSES]).toEqual(["pending_approval", "approved", "scheduled", "publishing"]);
    const img = await upload("guard.png");
    const post = await addPost([{ sourceUrl: publicPostImageUrl(img.token) }], "scheduled");
    expect(await codeOf(run(org.manager, "postImages.delete", { id: img.id }))).toBe("CONFLICT");
    expect(await codeOf(run({ ...org.manager, surface: "mcp" }, "postImages.delete", { id: img.id }))).toBe("FORBIDDEN");
    await db.update(posts).set({ status: "cancelled" }).where(eq(posts.id, post.id));
    await addPost([{ sourceUrl: publicPostImageUrl(img.token) }], "draft");
    await run(org.manager, "postImages.delete", { id: img.id });
    expect(await getPublicPostImage(db, img.token)).toBeNull();
    expect(await db.select().from(postImages).where(eq(postImages.id, img.id))).toHaveLength(0);
  });

  it("renames within the workspace and cleans the name", async () => {
    const img = await upload("old.png");
    const r = await run<{ image: { name: string } }>(org.manager, "postImages.rename", { id: img.id, name: "  new/name.png " });
    expect(r.image.name).toBe("name.png");
    expect(await codeOf(run(org.approverA, "postImages.rename", { id: img.id, name: "x.png" }))).toBe("FORBIDDEN");
  });
});

describe("POST /api/post-images handler", () => {
  const now = Date.now();
  const session = (userId: string, twoFactorEnabled: boolean) => ({
    session: { createdAt: new Date(now - 1000), expiresAt: new Date(now + 3_600_000) },
    user: { id: userId, email: `${userId}@example.test`, twoFactorEnabled },
  });
  const req = (bytes: Uint8Array | null, name = "p.png") => {
    const f = new FormData();
    f.set("workspaceId", org.a);
    if (bytes) f.set("file", new File([bytes as unknown as Blob], name, { type: "image/png" }));
    return new Request("http://localhost/api/post-images", { method: "POST", body: f });
  };
  const call = (r: Request, s: ReturnType<typeof session> | null) =>
    handlePostImageUpload(r, { db, getSession: async () => s });

  it("401 without a session, 403 without MFA, 201 with the image, 400 on a GIF or no file", async () => {
    expect((await call(req(png(800, 600)), null)).status).toBe(401);
    expect((await call(req(png(800, 600)), session(org.ownerId, false))).status).toBe(403);
    const ok = await call(req(png(800, 600)), session(org.ownerId, true));
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { ok: boolean; image: { id: string; url: string } };
    expect(body.ok).toBe(true);
    expect(body.image.url).toMatch(new RegExp(`^${BASE}/m/[0-9a-f]{48}$`));
    expect((await call(req(gif()), session(org.ownerId, true))).status).toBe(400);
    expect((await call(req(null), session(org.ownerId, true))).status).toBe(400);
  });
});
