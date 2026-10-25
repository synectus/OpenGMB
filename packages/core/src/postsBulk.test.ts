import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, posts, postTargets } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { processProfileSnapshot } from "./profile/watch";
import { codeOf, makeKit, type Org } from "./testkit";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type Preview = {
  fileErrors: string[];
  total: number;
  valid: number;
  withErrors: number;
  rows: { line: number; location: string | null; summary: string; errors: string[]; warnings: string[]; scheduledFor: string | null }[];
};
type Created = { created: number; drafts: { postId: string; line: number; location: string }[] };

let org: Org;
const cities = ["Austin", "Dallas", "Houston", "Rivermoor", "Plano", "Waco", "Tyler", "Irving", "Frisco", "Katy"];
const stamp = String(Date.now()).slice(-6);
const titleOf = (i: number) => `Acme ${cities[i]} ${stamp}`;
const csvOf = (rows: string[]) => ["location,type,summary,cta_type,cta_url,scheduled", ...rows].join("\n");
const draftsIn = (workspaceId: string) => db.select().from(posts).where(eq(posts.workspaceId, workspaceId));

beforeAll(async () => {
  org = await kit.makeOrg();
  for (let i = 0; i < cities.length; i++) {
    const l = await org.mkLoc(org.a, {
      title: titleOf(i),
      phone: `+1 555 010 01${String(i).padStart(2, "0")}`,
      addressSummary: `${i + 1} Main St, ${cities[i]}, TX 7870${i}, US`,
    });
    // Websites come from the newest profile snapshot, stored by the real snapshot job (shape: { fields, attributes }).
    mock.editLocation(l.google, { websiteUri: `https://${cities[i]!.toLowerCase()}.acme.test` }, ["websiteUri"]);
    expect(await processProfileSnapshot(db, { locationId: l.row.id }, { client: mock })).toBe("baseline");
  }
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

describe("posts.bulkCreateDrafts", () => {
  it("a 10-row CSV makes 10 drafts with their variables filled in", async () => {
    const lines = cities.map(
      (c, i) => `"${titleOf(i)}",STANDARD,"Hello from {name}, {city}: see {website}",LEARN_MORE,{website}/visit,`,
    );
    const csv = csvOf(lines);
    const pv = await run<Preview>(org.manager, "posts.bulkPreview", { workspaceId: org.a, csv });
    expect(pv).toMatchObject({ fileErrors: [], total: 10, valid: 10, withErrors: 0 });
    expect(pv.rows[0]!.summary).toBe(`Hello from ${titleOf(0)}, Austin: see https://austin.acme.test`);

    const before = (await draftsIn(org.a)).length;
    const r = await run<Created>(org.manager, "posts.bulkCreateDrafts", { workspaceId: org.a, csv });
    expect(r.created).toBe(10);
    const made = (await draftsIn(org.a)).filter((p) => r.drafts.some((d) => d.postId === p.id));
    expect(made).toHaveLength(10);
    expect((await draftsIn(org.a)).length - before).toBe(10);
    for (const [i, c] of cities.entries()) {
      const p = made.find((m) => m.summary.includes(`from ${titleOf(i)},`))!;
      expect(p.status).toBe("draft");
      expect(p.summary).toBe(`Hello from ${titleOf(i)}, ${c}: see https://${c.toLowerCase()}.acme.test`);
      expect(p.cta).toEqual({ actionType: "LEARN_MORE", url: `https://${c.toLowerCase()}.acme.test/visit` });
      expect(p.createdBy).toBe(org.manager.userId);
      const targets = await db.select().from(postTargets).where(eq(postTargets.postId, p.id));
      expect(targets).toHaveLength(1);
    }
    expect((await kit.auditRows(org.orgId, "post.draft_created")).length).toBeGreaterThanOrEqual(10);
    expect(await kit.auditRows(org.orgId, "post.bulk_drafted")).toHaveLength(1);
  });

  it("creates nothing when any row has an error (all or nothing)", async () => {
    const before = (await draftsIn(org.a)).length;
    const csv = csvOf([`"${titleOf(0)}",,Good row,,,`, `${titleOf(1)},,Bad {nope},,,`, `Nowhere,,Hi,,,`]);
    const pv = await run<Preview>(org.manager, "posts.bulkPreview", { workspaceId: org.a, csv });
    expect(pv).toMatchObject({ total: 3, valid: 1, withErrors: 2 });
    expect(pv.rows[1]!.errors[0]).toContain("{nope}");
    expect(pv.rows[2]!.errors[0]).toContain("Nowhere");
    expect(await codeOf(run(org.manager, "posts.bulkCreateDrafts", { workspaceId: org.a, csv }))).toBe("INVALID_INPUT");
    expect((await draftsIn(org.a)).length).toBe(before);
  });

  it("warns, but still creates, when a guardrail finds a problem (a phone number in the text)", async () => {
    const csv = csvOf([`${titleOf(2)},,Call us on {phone} today,,,`]);
    const pv = await run<Preview>(org.manager, "posts.bulkPreview", { workspaceId: org.a, csv });
    expect(pv.withErrors).toBe(0);
    expect(pv.rows[0]!.warnings.length).toBeGreaterThan(0);
    const r = await run<Created>(org.manager, "posts.bulkCreateDrafts", { workspaceId: org.a, csv });
    expect(r.created).toBe(1);
  });

  it("keeps the send time as a draft time in the client's zone and never schedules", async () => {
    const [ws] = [org.a];
    const csv = csvOf([`${titleOf(3)},,Timed,,,2099-12-01 09:00`]);
    const r = await run<Created>(org.manager, "posts.bulkCreateDrafts", { workspaceId: ws, csv });
    const [p] = await db.select().from(posts).where(eq(posts.id, r.drafts[0]!.postId));
    expect(p!.status).toBe("draft");
    expect(p!.scheduledFor).toEqual(new Date("2099-12-01T09:00:00Z")); // the client's zone is UTC unless set
    const pending = await db.select().from(postTargets).where(and(eq(postTargets.postId, p!.id), eq(postTargets.status, "pending")));
    expect(pending).toHaveLength(1);
  });

  it("is limited by role, by client and by the row cap", async () => {
    const csv = csvOf([`${titleOf(0)},,Hi,,,`]);
    expect(await codeOf(run(org.viewerA, "posts.bulkPreview", { workspaceId: org.a, csv }))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.viewerA, "posts.bulkCreateDrafts", { workspaceId: org.a, csv }))).toBe("FORBIDDEN");
    // A location of client A is not a location of client B.
    const other = await run<Preview>(org.manager, "posts.bulkPreview", { workspaceId: org.b, csv });
    expect(other.rows[0]!.errors[0]).toContain("No location named");
    const many = csvOf(Array.from({ length: 501 }, () => `${titleOf(0)},,Hi,,,`));
    const capped = await run<Preview>(org.manager, "posts.bulkPreview", { workspaceId: org.a, csv: many });
    expect(capped.fileErrors[0]).toMatch(/at most 500/);
    expect(capped.rows).toEqual([]);
  });

  it("MCP dry run describes the result and writes nothing", async () => {
    const { executeToolCall } = await import("./executor");
    const before = (await draftsIn(org.a)).length;
    const csv = csvOf([`${titleOf(4)},,Dry,,,`]);
    const out = (await executeToolCall(db, { ...org.manager, surface: "mcp", actorType: "api_token" }, "posts.bulkCreateDrafts", {
      workspaceId: org.a,
      csv,
      dryRun: true,
    })) as { dryRun: boolean; preview: { summary: string } };
    expect(out.dryRun).toBe(true);
    expect(out.preview.summary).toContain("Would create 1 draft");
    expect((await draftsIn(org.a)).length).toBe(before);
  });
});
