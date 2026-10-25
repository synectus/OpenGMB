import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, locationImports, workspaces } from "@opengmb/db";
import { PgBoss } from "pg-boss";
import { MockGoogleClient } from "./google/mock-client";
import { LOCATION_IMPORT_QUEUE, processLocationImport } from "./locations/import";
import { LOCATION_CENTER_QUEUE } from "./locations/center";
import { REVIEW_SYNC_QUEUE } from "./reviews/sync";
import { PERFORMANCE_SNAPSHOT_QUEUE } from "./performance/snapshot";
import { codeOf, makeKit, uniq, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;
const boss = new PgBoss(url);
let org: Org;
beforeAll(async () => {
  await boss.start();
  for (const q of [LOCATION_IMPORT_QUEUE, LOCATION_CENTER_QUEUE, REVIEW_SYNC_QUEUE, PERFORMANCE_SNAPSHOT_QUEUE]) await boss.createQueue(q);
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await boss.stop();
  await sql.end();
});

const zoneOf = async (id: string) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return `${w!.timeZone}/${w!.timeZoneSource}`;
};
const formatOf = async (id: string) => {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return `${w!.dateFormat}/${w!.dateFormatSource}`;
};

/** Run the worker side of an import against a fake Google that returns `found`. */
async function importFrom(
  workspaceId: string,
  found: { regionCode: string; administrativeArea?: string }[],
) {
  const [conn] = await sql<{ id: string }[]>`select id from google_connections where org_id = ${org.orgId} limit 1`;
  const tag = uniq().replace(/\D/g, "").slice(-9);
  const gl = found.map((a, i) => ({
    name: `locations/9${tag}${i}`,
    title: `TZ ${tag}-${i}`,
    storefrontAddress: a,
  }));
  const [req] = await db
    .insert(locationImports)
    .values({
      orgId: org.orgId,
      workspaceId,
      connectionId: conn!.id,
      requestedBy: org.ownerId,
      items: gl.map((l) => ({ accountName: "accounts/1", locationName: l.name })),
    })
    .returning();
  const res = await processLocationImport(db, req!.id, {
    client: { listLocations: async () => ({ locations: gl }) } as never,
  });
  return res!;
}

describe("workspace time zone", () => {
  it("is UTC/default until the first import, derives from the first location once", async () => {
    expect(await zoneOf(org.a)).toBe("UTC/default");
    const r = await importFrom(org.a, [{ regionCode: "IN", administrativeArea: "Gujarat" }]);
    expect(r[0]!.result).toBe("imported");
    expect(await zoneOf(org.a)).toBe("Asia/Kolkata/derived");
    expect(await formatOf(org.a)).toBe("DD/MM/YYYY/derived");
    // a later import from another country does not change it
    await importFrom(org.a, [{ regionCode: "US", administrativeArea: "TX" }]);
    expect(await zoneOf(org.a)).toBe("Asia/Kolkata/derived");
    expect(await formatOf(org.a)).toBe("DD/MM/YYYY/derived");
  });

  it("a manual choice is never overwritten by an import", async () => {
    await run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.b, timeZone: "Europe/London" });
    await importFrom(org.b, [{ regionCode: "AU", administrativeArea: "WA" }]);
    expect(await zoneOf(org.b)).toBe("Europe/London/manual");
    // the format was never chosen by hand, so it still derives (AU is day first)
    expect(await formatOf(org.b)).toBe("DD/MM/YYYY/derived");
    const [w] = await db.insert(workspaces).values({ orgId: org.orgId, name: `D-${uniq()}` }).returning();
    await run(org.owner, "workspaces.setTimeSettings", { workspaceId: w!.id, dateFormat: "YYYY-MM-DD" });
    await importFrom(w!.id, [{ regionCode: "US", administrativeArea: "TX" }]);
    expect(await formatOf(w!.id)).toBe("YYYY-MM-DD/manual"); // a hand-set format is never overwritten
    expect(await zoneOf(w!.id)).toBe("America/Chicago/derived");
    const [us] = await db.insert(workspaces).values({ orgId: org.orgId, name: `U-${uniq()}` }).returning();
    await importFrom(us!.id, [{ regionCode: "US", administrativeArea: "CA" }]);
    expect(await formatOf(us!.id)).toBe("MM/DD/YYYY/derived");
    const [fr] = await db.insert(workspaces).values({ orgId: org.orgId, name: `F-${uniq()}` }).returning();
    await importFrom(fr!.id, [{ regionCode: "FR" }]);
    expect(await formatOf(fr!.id)).toBe("YYYY-MM-DD/default");
  });

  it("uses the state for AU and US", async () => {
    const [w] = await db.insert(workspaces).values({ orgId: org.orgId, name: `C-${uniq()}` }).returning();
    await importFrom(w!.id, [{ regionCode: "AU", administrativeArea: "WA" }]);
    expect(await zoneOf(w!.id)).toBe("Australia/Perth/derived");
  });

  it("workspaces.list shows the zone and format; setTimeSettings validates, audits, needs permission", async () => {
    const list = (await run(org.owner, "workspaces.list")) as { workspaces: { id: string; timeZone: string; dateFormat: string }[] };
    expect(list.workspaces.find((w) => w.id === org.a)).toMatchObject({ timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" });
    const out = (await run(org.owner, "workspaces.setTimeSettings", {
      workspaceId: org.a,
      timeZone: "America/Chicago",
      dateFormat: "MM/DD/YYYY",
    })) as { workspace: { timeZone: string; dateFormat: string; timeZoneSource: string } };
    expect(out.workspace).toMatchObject({ timeZone: "America/Chicago", dateFormat: "MM/DD/YYYY", timeZoneSource: "manual" });
    expect(await codeOf(run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.a, timeZone: "Mars/Base" }))).not.toBe("no error");
    expect(await codeOf(run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.a }))).not.toBe("no error");
    expect(await codeOf(run(org.viewerA, "workspaces.setTimeSettings", { workspaceId: org.a, timeZone: "UTC" }))).not.toBe("no error");
    expect((await kit.auditRows(org.orgId, "workspace.time_settings_set")).length).toBe(3); // two from the import tests, one here
    // Asia/Kolkata is accepted though supportedValuesOf only lists Asia/Calcutta
    await run(org.owner, "workspaces.setTimeSettings", { workspaceId: org.a, timeZone: "Asia/Kolkata" });
  });
});
