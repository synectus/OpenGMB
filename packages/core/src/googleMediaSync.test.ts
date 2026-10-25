import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, googleMedia } from "@opengmb/db";
import type { GoogleMediaItem } from "./google/client";
import { MockGoogleClient } from "./google/mock-client";
import { syncGoogleMedia } from "./media/google-sync";
import { makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());

let org: Org;
let loc: Loc;
let remote: GoogleMediaItem[] = [];
const fake = { listMedia: async () => ({ mediaItems: structuredClone(remote) }) };
const photo = (n: number, extra: Partial<GoogleMediaItem> = {}): GoogleMediaItem => ({
  name: `${loc.parent}/media/M${n}`,
  mediaFormat: "PHOTO",
  googleUrl: `https://lh3.googleusercontent.test/p${n}`,
  thumbnailUrl: `https://lh3.googleusercontent.test/t${n}`,
  createTime: `2026-10-0${n}T10:00:00Z`,
  locationAssociation: { category: "EXTERIOR" },
  dimensions: { widthPixels: 800, heightPixels: 600 },
  ...extra,
});
const rows = () => db.select().from(googleMedia).where(eq(googleMedia.locationId, loc.row.id));

beforeAll(async () => {
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("syncGoogleMedia", () => {
  it("stores photo URLs and fields, skips videos and items without a URL, and is idempotent", async () => {
    remote = [photo(1, { description: "Front door" }), photo(2), photo(3, { mediaFormat: "VIDEO" }), photo(4, { googleUrl: undefined })];
    expect(await syncGoogleMedia(db, loc.row, fake)).toEqual({ fetched: 2, removed: 0, truncated: false });
    await syncGoogleMedia(db, loc.row, fake);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.googleMediaName.endsWith("M1"))).toMatchObject({
      category: "EXTERIOR", description: "Front door", googleUrl: "https://lh3.googleusercontent.test/p1",
      thumbnailUrl: "https://lh3.googleusercontent.test/t1", widthPixels: 800, heightPixels: 600,
    });
  });

  it("removes photos Google no longer lists, and keeps them all when the list is empty only if truncated", async () => {
    remote = [photo(2)];
    expect(await syncGoogleMedia(db, loc.row, fake)).toMatchObject({ fetched: 1, removed: 1 });
    expect((await rows()).map((x) => x.googleMediaName)).toEqual([`${loc.parent}/media/M2`]);
    remote = [];
    expect(await syncGoogleMedia(db, loc.row, fake)).toMatchObject({ fetched: 0, removed: 1 });
    expect(await rows()).toHaveLength(0);
  });
});
