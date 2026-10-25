import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiUsage, auditLog, createDb, postImages } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, type Org } from "./testkit";
import { setAiTestOverrides } from "./ai/model";
import { withMarkupMicro } from "./billing";
import { AI_IMAGE_PROMPT_GUARD, AI_IMAGES, STOCK_PHOTOS } from "./config/post-image-sources";
import { setImageProviderOverrides } from "./postImages/providers";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;

/** Just enough JPEG for inspectImage: SOI, SOF0 with the size, padding. */
function jpeg(w: number, h: number, size = 20_000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255]);
  return b;
}
type Out = { // loose result shape for assertions only
  stock: { available: boolean };
  ai: { available: boolean; chargeMicroUsd: number; charged: boolean };
  results: { id: string; creditName: string; creditUrl: string }[];
  hasMore: boolean;
  image: { id: string; url: string; creditName: string; aiGenerated: boolean };
  chargedMicroUsd: number;
  images: { id: string }[];
};
const SUBJECT = "ZQXSUBJECTCANARY a bowl of fresh fruit";
// Documented Pixabay hit (https://pixabay.com/api/docs/): GET /api/?key=&q= and GET /api/?key=&id=.
const pixabayHit = (id: number, host = "pixabay.com") => ({
  id,
  pageURL: `https://pixabay.com/photos/fruit-${id}/`,
  type: "photo",
  tags: "fruit, bowl, fresh",
  previewURL: `https://cdn.pixabay.com/photo/2020/01/01/fruit-${id}_150.jpg`,
  previewWidth: 150,
  previewHeight: 100,
  webformatURL: `https://${host === "pixabay.com" ? "pixabay.com/get" : host}/fruit-${id}_640.jpg`,
  webformatWidth: 640,
  webformatHeight: 427,
  largeImageURL: `https://${host === "pixabay.com" ? "pixabay.com/get" : host}/fruit-${id}_1280.jpg`,
  imageWidth: 3000,
  imageHeight: 2000,
  imageSize: 1234567,
  views: 100,
  downloads: 50,
  likes: 5,
  comments: 0,
  user_id: 7,
  user: "Jane_Doe",
  userImageURL: "https://cdn.pixabay.com/user/2020/01/01/jane-250x250.jpg",
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

const seen: { url: string; init?: RequestInit }[] = [];
let evilHost = false;
let rateLimited = false;
let openaiBody: { b64_json?: string }[] | null = null;
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(input);
  seen.push({ url: u, init });
  if (u.startsWith(STOCK_PHOTOS.searchUrl)) {
    const q = new URL(u).searchParams;
    if (q.get("id")) {
      const id = Number(q.get("id"));
      return json(id === 404 ? { total: 0, totalHits: 0, hits: [] } : { total: 1, totalHits: 1, hits: [pixabayHit(id, evilHost ? "evil.example" : undefined)] });
    }
    if (rateLimited) return json({ error: "API rate limit exceeded" }, 429);
    return json({ total: 900, totalHits: 500, hits: [pixabayHit(11), pixabayHit(12)] });
  }
  if (new URL(u).hostname === "pixabay.com" || new URL(u).hostname === "cdn.pixabay.com") return new Response(jpeg(1880, 1253).buffer as ArrayBuffer);
  if (u === AI_IMAGES.endpoint) {
    return json({ created: 1, data: openaiBody ?? [{ b64_json: Buffer.from(jpeg(1280, 960)).toString("base64") }], usage: { input_tokens: 40, output_tokens: 1580 } });
  }
  throw new Error(`unexpected network call ${u}`);
}) as typeof fetch;

const keys = { PIXABAY_API_KEY: "pixabay-test-key", OPENAI_API_KEY: "sk-test-key" };
function setup(opts: { keys?: boolean } = {}) {
  const env = { ...(opts.keys === false ? {} : keys) };
  setImageProviderOverrides({ fetch: fakeFetch, env });
  setAiTestOverrides({ env: { AI_MONTHLY_BUDGET_USD: "1000" } });
}

let org: Org;
beforeAll(async () => {
  process.env.BETTER_AUTH_URL = "https://app.example";
  org = await kit.makeOrg();
});
afterAll(async () => {
  setAiTestOverrides({});
  setImageProviderOverrides({});
  await kit.deactivateAll();
  await sql.end();
});
beforeEach(() => {
  seen.length = 0;
  evilHost = false;
  rateLimited = false;
  openaiBody = null;
  setup();
});

describe("A8 config", () => {
  it("uses the exact model id and carries a source and a verified-on date", () => {
    expect(AI_IMAGES.model).toBe("gpt-image-2.5-sunburst-2026-09-08");
    expect(AI_IMAGES.verifiedOn).toBe("2026-10-24");
    expect(AI_IMAGES.pricingSourceUrl).toMatch(/^https:\/\//);
    expect(STOCK_PHOTOS.sourceUrl).toMatch(/^https:\/\//);
    expect(STOCK_PHOTOS.verifiedOn).toBe("2026-10-24");
  });
});

describe("postImages.sources", () => {
  it("says not set up without keys and gives the price shown before generating", async () => {
    setup({ keys: false });
    const r = (await run(org.manager, "postImages.sources", { workspaceId: org.a })) as Out;
    expect(r.stock.available).toBe(false);
    expect(r.ai.available).toBe(false);
    setup();
    const k = (await run(org.manager, "postImages.sources", { workspaceId: org.a })) as Out;
    expect(k.stock.available).toBe(true);
    expect(k.ai.available).toBe(true);
    const cost = Math.ceil((AI_IMAGES.estimatedOutputTokens * AI_IMAGES.imageOutputPerMTokMicroUsd) / 1_000_000);
    expect(k.ai.chargeMicroUsd).toBe(withMarkupMicro(cost));
    expect(k.ai.charged).toBe(false);
  });
});

describe("stock photos", () => {
  it("search is free, sends the key and returns credits; not set up is NOT_CONFIGURED", async () => {
    const r = (await run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "fruit" })) as Out;
    expect(r.results.map((x: { id: string }) => x.id)).toEqual(["11", "12"]);
    expect(r.results[0]).toMatchObject({ creditName: "Jane_Doe", creditUrl: "https://pixabay.com/photos/fruit-11/" });
    expect(r.hasMore).toBe(true);
    const q = new URL(seen[0]!.url).searchParams;
    expect(q.get("key")).toBe("pixabay-test-key");
    expect(q.get("q")).toBe("fruit");
    expect(q.get("per_page")).toBe(String(STOCK_PHOTOS.perPage));
    expect(await db.select().from(aiUsage).where(eq(aiUsage.orgId, org.orgId))).toHaveLength(0);
    setup({ keys: false });
    expect(await codeOf(run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "x" }))).toBe("NOT_CONFIGURED");
  });

  it("search is cached for 24 hours, so a repeat search makes no call; hasMore stops at the API cap", async () => {
    await run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "Cache me" });
    await run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "cache me" });
    expect(seen).toHaveLength(1);
    const last = (await run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "cache me", page: 21 })) as Out;
    expect(last.hasMore).toBe(false);
  });

  it("a 429 is a plain busy message; an unknown id is NOT_FOUND", async () => {
    rateLimited = true;
    await expect(run(org.manager, "postImages.searchStock", { workspaceId: org.a, query: "busy" })).rejects.toThrow(/busy/);
    expect(await codeOf(run(org.manager, "postImages.addStock", { workspaceId: org.a, stockPhoto: "404" }))).toBe("NOT_FOUND");
  });

  it("a viewer cannot search or add", async () => {
    expect(await codeOf(run(org.viewerA, "postImages.searchStock", { workspaceId: org.a, query: "x" }))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.viewerA, "postImages.addStock", { workspaceId: org.a, stockPhoto: "11" }))).toBe("FORBIDDEN");
  });

  it("addStock saves into the library with the photographer credit and lists it", async () => {
    const r = (await run(org.manager, "postImages.addStock", { workspaceId: org.a, stockPhoto: "11" })) as Out;
    expect(r.image.creditName).toBe("Jane_Doe");
    expect(r.image.url).toMatch(/^https:\/\/app\.example\/m\/[0-9a-f]{48}$/);
    const [row] = await db.select().from(postImages).where(eq(postImages.id, r.image.id));
    expect(row).toMatchObject({ source: "stock", creditName: "Jane_Doe", aiGenerated: false, orgId: org.orgId });
    const list = (await run(org.manager, "postImages.list", { workspaceId: org.a })) as Out;
    const got = list.images.find((i: { id: string }) => i.id === r.image.id);
    expect(got).toMatchObject({ source: "stock", creditName: "Jane_Doe", creditUrl: "https://pixabay.com/photos/fruit-11/", aiGenerated: false });
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["pixabay.com", "pixabay.com"]);
  });

  it("never downloads from a host other than the provider's image host", async () => {
    evilHost = true;
    expect(await codeOf(run(org.manager, "postImages.addStock", { workspaceId: org.a, stockPhoto: "13" }))).toBe("CONFLICT");
    expect(seen.every((s) => new URL(s.url).host === "pixabay.com" && new URL(s.url).pathname === "/api/")).toBe(true);
  });

  it("rejects a non-numeric photo id", async () => {
    expect(await codeOf(run(org.manager, "postImages.addStock", { workspaceId: org.a, stockPhoto: "../x" }))).toBe("INVALID_INPUT");
  });
});

describe("a draft carries the image", () => {
  it("a stock and an AI image attach to a post draft through the existing media path and show as used", async () => {
    const stock = (await run(org.manager, "postImages.addStock", { workspaceId: org.a, stockPhoto: "11" })) as Out;
    const ai = (await run(org.manager, "postImages.generate", { workspaceId: org.a, subject: SUBJECT })) as Out;
    const loc = (await org.mkLoc(org.a)).row.id;
    for (const img of [stock.image, ai.image]) {
      await run(org.manager, "posts.createDraft", {
        workspaceId: org.a, locationIds: [loc], topicType: "STANDARD", summary: "Fresh fruit in this week.", media: [{ sourceUrl: img.url }],
      });
    }
    const list = (await run(org.manager, "postImages.list", { workspaceId: org.a })) as unknown as { images: { id: string; usedIn: unknown[] }[] };
    for (const img of [stock.image, ai.image]) {
      expect(list.images.find((i) => i.id === img.id)!.usedIn).toHaveLength(1);
    }
  });
});

describe("AI images", () => {
  const gen = (o: Org = org) => run(o.manager, "postImages.generate", { workspaceId: o.a, subject: SUBJECT }) as Promise<Out>;
  const body = () => JSON.parse(String(seen.find((s) => s.url === AI_IMAGES.endpoint)!.init!.body));

  it("sends the configured model and size with the illustration guard, and saves an AI-flagged image", async () => {
    const r = await gen();
    const b = body();
    expect(b).toMatchObject({ model: AI_IMAGES.model, size: AI_IMAGES.size, quality: AI_IMAGES.quality, n: 1 });
    expect(b.prompt.startsWith(AI_IMAGE_PROMPT_GUARD)).toBe(true);
    expect(b.prompt).toContain(SUBJECT);
    expect(r.image.aiGenerated).toBe(true);
    const [row] = await db.select().from(postImages).where(eq(postImages.id, r.image.id));
    expect(row).toMatchObject({ source: "ai", aiGenerated: true, creditName: null });
    const [u] = await db.select().from(aiUsage).where(eq(aiUsage.orgId, org.orgId));
    expect(u).toMatchObject({ action: "postImages.generate", model: AI_IMAGES.model, outputTokens: 1580 });
    expect(u!.costMicroUsd).toBe(Math.ceil((AI_IMAGES.estimatedOutputTokens * AI_IMAGES.imageOutputPerMTokMicroUsd) / 1_000_000));
  });

  it("the prompt text never reaches the audit log", async () => {
    await gen();
    const rows = await db.select().from(auditLog).where(eq(auditLog.orgId, org.orgId));
    expect(JSON.stringify(rows)).not.toContain("ZQXSUBJECTCANARY");
    expect(rows.some((r) => r.action === "post_image.generated")).toBe(true);
  });

  it("not set up is NOT_CONFIGURED and nothing is charged", async () => {
    setup({ keys: false });
    expect(await codeOf(gen())).toBe("NOT_CONFIGURED");
    expect(seen).toHaveLength(0);
  });

  it("the monthly AI limit is enforced", async () => {
    setAiTestOverrides({ env: { AI_MONTHLY_BUDGET_USD: "0" } });
    await expect(gen()).rejects.toThrow(/^AI_BUDGET_EXCEEDED:/);
    expect(seen).toHaveLength(0);
  });

  it("a response with no image is a plain error and charges nothing", async () => {
    openaiBody = [];
    const poorBefore = (await db.select().from(aiUsage).where(eq(aiUsage.orgId, org.orgId))).length;
    expect(await codeOf(gen())).toBe("CONFLICT");
    expect((await db.select().from(aiUsage).where(eq(aiUsage.orgId, org.orgId))).length).toBe(poorBefore);
  });

  it("a viewer cannot generate", async () => {
    expect(await codeOf(run(org.viewerA, "postImages.generate", { workspaceId: org.a, subject: SUBJECT }))).toBe("FORBIDDEN");
  });
});
