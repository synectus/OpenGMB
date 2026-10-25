import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, sql as dsql } from "drizzle-orm";
import { createDb, locations, organizations, workspaces } from "@opengmb/db";
import { AU_STATE_TIME_ZONE, COUNTRY_DATE_FORMAT, COUNTRY_TIME_ZONE, US_STATE_TIME_ZONE } from "../config/time-zones";
import { uniq } from "../testkit";

const dir = join(__dirname, "../../../db/drizzle");
const file = readdirSync(dir).find((f) => f.includes("_") && readFileSync(join(dir, f), "utf8").includes('"time_zone_source"') && f.endsWith(".sql"));
const text = file ? readFileSync(join(dir, file), "utf8") : "";
const backfillStatements = text.slice(text.indexOf("-- F4 backfill")).split("--> statement-breakpoint");
const backfill = backfillStatements.join("\n");

describe("time zone migration", () => {
  it("found the migration (canary)", () => {
    expect(file).toBeTruthy();
    expect(backfill).toContain("'Asia/Kolkata'");
  });

  it("repeats every config mapping", () => {
    const all = [
      ...Object.entries(COUNTRY_TIME_ZONE).map(([k, z]) => [`country = '${k}'`, z] as const),
      ...Object.values(US_STATE_TIME_ZONE).map((z) => ["", z] as const),
      ...Object.values(AU_STATE_TIME_ZONE).map((z) => ["", z] as const),
    ];
    expect(all.length).toBeGreaterThan(10);
    for (const [needle, z] of all) {
      expect(backfill).toContain(`'${z}'`);
      expect(backfill).toContain(needle);
    }
    for (const [c, f] of Object.entries(COUNTRY_DATE_FORMAT)) {
      expect(backfill).toMatch(new RegExp(`'${c}'`));
      expect(backfill).toContain(`THEN '${f}'`);
    }
    for (const k of [...Object.keys(US_STATE_TIME_ZONE), ...Object.keys(AU_STATE_TIME_ZONE)]) {
      expect(backfill).toMatch(new RegExp(`'${k}'`));
    }
  });
});

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const orgIds: string[] = [];
afterAll(async () => {
  if (orgIds.length) {
    await db.delete(locations).where(inArray(locations.orgId, orgIds));
    await db.delete(workspaces).where(inArray(workspaces.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  await sql.end();
});

describe("time zone backfill", () => {
  it("derives zones for existing workspaces from address_summary", async () => {
    const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    orgIds.push(org!.id);
    const orgId = org!.id;
    const cases: [string, string | null, string, "derived" | "default", string, "derived" | "default"][] = [
      ["in", "1 MG Road, Ahmedabad, Gujarat 380001, IN", "Asia/Kolkata", "derived", "DD/MM/YYYY", "derived"],
      ["au-wa", "5 Hay St, Perth, WA 6000, AU", "Australia/Perth", "derived", "DD/MM/YYYY", "derived"],
      ["au", "5 George St, Sydney, NSW 2000, AU", "Australia/Sydney", "derived", "DD/MM/YYYY", "derived"],
      ["us-tx", "100 Main St, Rivermoor, TX 75940, US", "America/Chicago", "derived", "MM/DD/YYYY", "derived"],
      ["us-ca", "1 Market St, San Francisco, CA 94105, US", "America/Los_Angeles", "derived", "MM/DD/YYYY", "derived"],
      ["gb", "10 Downing St, London, SW1A 2AA, GB", "Europe/London", "derived", "DD/MM/YYYY", "derived"],
      ["nz", "1 Queen St, Auckland, 1010, NZ", "UTC", "default", "DD/MM/YYYY", "derived"], // no zone mapped for NZ, but the format is
      ["fr", "1 Rue X, Paris, 75001, FR", "UTC", "default", "YYYY-MM-DD", "default"],
      ["none", null, "UTC", "default", "YYYY-MM-DD", "default"],
    ];
    const ws = await db.insert(workspaces).values(cases.map(([n]) => ({ orgId, name: n }))).returning();
    for (const [i, [n, addr]] of cases.entries()) {
      if (addr) await db.insert(locations).values({ orgId, workspaceId: ws[i]!.id, name: n, addressSummary: addr });
    }
    await db.transaction(async (tx) => {
      for (const stmt of backfillStatements) await tx.execute(dsql.raw(stmt));
    });
    for (const [i, [n, , zone, src, fmt, fsrc]] of cases.entries()) {
      const [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws[i]!.id));
      expect([n, w!.timeZone, w!.timeZoneSource, w!.dateFormat, w!.dateFormatSource]).toEqual([n, zone, src, fmt, fsrc]);
    }
  });
});
