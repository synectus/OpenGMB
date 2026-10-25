import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, locationImports, locations } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { LOCATION_IMPORT_QUEUE, processLocationImport } from "./locations/import";
import { REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { PERFORMANCE_SNAPSHOT_QUEUE } from "./performance/snapshot";
import { makeKit, uniq, type Org } from "./testkit";

// Production deploys web (and its migrations) before the worker that creates `locations.center_resolve`.
// Every enqueue of that job is redirected to a queue that does not exist, which is what pg-boss sees then.
vi.mock("./jobs", async (orig) => {
  const real = await orig<typeof import("./jobs")>();
  return {
    ...real,
    enqueueJob: (tx: Parameters<typeof real.enqueueJob>[0], queue: string, data: object) =>
      real.enqueueJob(tx, queue === "locations.center_resolve" ? "locations.center_resolve.never_created" : queue, data),
  };
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const boss = new PgBoss(url);
let org: Org;
beforeAll(async () => {
  await boss.start();
  for (const q of [LOCATION_IMPORT_QUEUE, REVIEW_SYNC_QUEUE, PERFORMANCE_SNAPSHOT_QUEUE]) await boss.createQueue(q);
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await boss.stop();
  await sql.end();
});

describe("import when the coordinate queue does not exist yet", () => {
  it("still imports the location and its other first jobs; the lookup is skipped with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [conn] = await sql<{ id: string }[]>`select id from google_connections where org_id = ${org.orgId} limit 1`;
    const tag = uniq().replace(/\D/g, "").slice(-9);
    const gl = { name: `locations/8${tag}`, title: `NoQueue ${tag}`, storefrontAddress: { regionCode: "US" } };
    const [req] = await db
      .insert(locationImports)
      .values({ orgId: org.orgId, workspaceId: org.a, connectionId: conn!.id, requestedBy: org.ownerId, items: [{ accountName: "accounts/1", locationName: gl.name }] })
      .returning();
    const res = await processLocationImport(db, req!.id, { client: { listLocations: async () => ({ locations: [gl] }) } as never });
    expect(res![0]).toMatchObject({ result: "imported" });
    const [row] = await db.select().from(locations).where(eq(locations.googleLocationId, gl.name));
    expect(row).toBeTruthy();
    const perf = await sql`select 1 from pgboss.job where name = ${PERFORMANCE_SNAPSHOT_QUEUE} and data->>'locationId' = ${row!.id}`;
    expect(perf).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not queue onboarding lookup"));
    warn.mockRestore();
  });
});
