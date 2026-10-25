import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, type Org } from "./testkit";
import { createPostImage } from "./postImages/store";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

function png(): Uint8Array {
  const b = new Uint8Array(20_000);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, 800);
  v.setUint32(20, 600);
  return b;
}
type T = { template: { id: string; name: string; image: { id: string; url: string } | null; updatedByName: string } };
let org: Org;
beforeAll(async () => {
  process.env.BETTER_AUTH_URL = "https://app.example";
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

const base = (over: Record<string, unknown> = {}) => ({
  workspaceId: org.a,
  name: "Saturday hours",
  topicType: "STANDARD",
  language: "es",
  summary: "Abrimos los sábados.",
  cta: { actionType: "CALL" },
  ...over,
});

describe("post templates", () => {
  it("creates, reads, lists, updates and deletes; names are unique per workspace", async () => {
    const img = await createPostImage(db, org.manager, { workspaceId: org.a, filename: "b.png", bytes: png() });
    const c = await run<T>(org.manager, "postTemplates.create", base({ imageId: img.id }));
    expect(c.template.image?.url).toMatch(/^https:\/\/app\.example\/m\/[0-9a-f]{48}$/);
    expect(c.template.updatedByName).toBe("T");
    expect(await codeOf(run(org.manager, "postTemplates.create", base()))).toBe("CONFLICT");
    const other = await run<T>(org.manager, "postTemplates.create", base({ name: "Other", workspaceId: org.b }));
    expect(other.template.name).toBe("Other"); // same name rule is per workspace
    const g = await run<T>(org.viewerA, "postTemplates.get", { id: c.template.id });
    expect(g.template.name).toBe("Saturday hours");
    const l = await run<{ templates: { id: string }[]; can: { manage: boolean } }>(org.viewerA, "postTemplates.list", { workspaceId: org.a });
    expect(l.templates.map((t) => t.id)).toContain(c.template.id);
    expect(l.can.manage).toBe(false);
    const u = await run<T>(org.manager, "postTemplates.update", { id: c.template.id, ...base({ name: "Saturday hours (ES)", imageId: null }) });
    expect(u.template).toMatchObject({ name: "Saturday hours (ES)", image: null });
    await run(org.manager, "postTemplates.delete", { id: c.template.id });
    expect(await codeOf(run(org.manager, "postTemplates.get", { id: c.template.id }))).toBe("NOT_FOUND");
  });

  it("refuses a viewer, a language that is not in the list, and an image from another workspace", async () => {
    expect(await codeOf(run(org.viewerA, "postTemplates.create", base({ name: "v" })))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.manager, "postTemplates.create", base({ name: "x", language: "xx" })))).toBe("INVALID_INPUT");
    const imgB = await createPostImage(db, org.manager, { workspaceId: org.b, filename: "b.png", bytes: png() });
    expect(await codeOf(run(org.manager, "postTemplates.create", base({ name: "y", imageId: imgB.id })))).toBe("INVALID_INPUT");
  });

  it("deleting a library image clears it from the template", async () => {
    const img = await createPostImage(db, org.manager, { workspaceId: org.a, filename: "c.png", bytes: png() });
    const c = await run<T>(org.manager, "postTemplates.create", base({ name: "Has image", imageId: img.id }));
    await run(org.manager, "postImages.delete", { id: img.id });
    const g = await run<T>(org.manager, "postTemplates.get", { id: c.template.id });
    expect(g.template.image).toBeNull();
  });
});
