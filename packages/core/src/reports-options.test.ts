import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deflateSync, inflateSync } from "node:zlib";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  locationGroupMembers,
  locationGroups,
  reportDefinitions,
  reportLanguages,
  reportRuns,
} from "@opengmb/db";
import type { Actor } from "./actor";
import { executeAction } from "./executor";
import { REPORT_LANGUAGES } from "./reports/labels";
import { REPORT_GENERATE_QUEUE, processReportRun } from "./reports/run";
import { codeOf, db, makeOrg, putDaily, sql, uniq, type Org } from "./performance-fixture";

const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T14:00:00Z");
const run = (actor: Actor, name: string, input: unknown = {}) => executeAction(db, actor, name, input);

/**
 * Same extractor as reports.test.ts: hex strings before Tj in (possibly deflated) streams. The
 * stream body ends at "\nendstream" with no optional "\r": a deflate stream whose last byte (the
 * Adler-32 low byte) is 0x0D would otherwise lose that byte and fail to inflate, about 1 PDF in 256.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const chunks: string[] = [raw];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"));
    } catch {
      // not deflated
    }
  }
  const out: string[] = [];
  for (const c of chunks) {
    for (const h of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1]!, "hex").toString("latin1"));
  }
  return out.join("\n");
}

type Def = {
  id: string;
  language: string;
  comment: string | null;
  groupId: string | null;
  scope: string;
  name: string;
};

let o: Org;
let other: Org;
let groupId: string;
let groupB: string;

const base = (over: Record<string, unknown> = {}) => ({
  workspaceId: o.wsA,
  name: `Options ${uniq()}`,
  scope: "workspace",
  locationIds: [],
  period: "custom",
  customFrom: "2026-09-01",
  customTo: "2026-09-30",
  schedule: "none",
  recipients: [],
  branding: { agencyName: "Synectus Agency" },
  ...over,
});
const create = async (over: Record<string, unknown> = {}) =>
  ((await run(o.manager, "reports.definitions.create", base(over))) as { definition: Def }).definition;

async function generateText(definitionId: string) {
  const r = (await run(o.manager, "reports.generate", { definitionId })) as { runId: string };
  const outcome = await processReportRun(db, r.runId, { now: NOW });
  const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, r.runId));
  return { runId: r.runId, outcome, row: row!, text: row!.pdf ? pdfText(row!.pdf) : "" };
}

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REPORT_GENERATE_QUEUE);
  o = await makeOrg();
  other = await makeOrg();
  await putDaily(o.orgId, o.locA1.id, [["2026-09-08", "CALL_CLICKS", 10]]);
  await putDaily(o.orgId, o.locA2.id, [["2026-09-09", "CALL_CLICKS", 7]]);
  const [g] = await db.insert(locationGroups).values({ orgId: o.orgId, workspaceId: o.wsA, name: `Downtown ${uniq()}` }).returning();
  groupId = g!.id;
  await db.insert(locationGroupMembers).values({ groupId, locationId: o.locA1.id, orgId: o.orgId });
  const [gb] = await db.insert(locationGroups).values({ orgId: o.orgId, workspaceId: o.wsB, name: `Other ${uniq()}` }).returning();
  groupB = gb!.id;
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

describe("definition options", () => {
  it("canary: pdfText reads a deflated stream whose last byte is 0x0D", () => {
    let z: Buffer | undefined;
    let hex = "";
    for (let i = 0; !z; i++) {
      hex = Buffer.from(`Resultados ${i}`).toString("hex");
      const d = deflateSync(Buffer.from(`BT <${hex}> Tj ET`));
      if (d[d.length - 1] === 0x0d) z = d;
    }
    const pdf = Buffer.concat([Buffer.from("stream\n"), z, Buffer.from("\nendstream")]);
    expect(pdfText(pdf)).toBe(Buffer.from(hex, "hex").toString("latin1"));
  });

  it("language list is the same in db and core", () => {
    expect([...reportLanguages]).toEqual([...REPORT_LANGUAGES]);
  });

  it("create defaults to English, no comment, no group", async () => {
    const d = await create();
    expect(d).toMatchObject({ language: "en", comment: null, groupId: null, scope: "workspace" });
  });

  it("a partial update keeps language and comment (zod 4 applies defaults inside optional fields)", async () => {
    const d = await create({ language: "es", comment: "Hola." });
    const u = (await run(o.manager, "reports.definitions.update", { id: d.id, name: "Renamed" })) as { definition: Def };
    expect(u.definition).toMatchObject({ name: "Renamed", language: "es", comment: "Hola." });
    const c = (await run(o.manager, "reports.definitions.update", { id: d.id, comment: null, language: "en" })) as { definition: Def };
    expect(c.definition).toMatchObject({ language: "en", comment: null });
  });

  it("normalises the comment, refuses what the PDF cannot print, and keeps its text out of audit", async () => {
    const d = await create({ comment: "  It’s “up” – good…  " });
    expect(d.comment).toBe('It\'s "up" - good...');
    expect(await codeOf(run(o.manager, "reports.definitions.create", base({ comment: "x".repeat(501) })))).toMatch(/^INVALID_INPUT/);
    expect(await codeOf(run(o.manager, "reports.definitions.create", base({ comment: "Party \u{1F389}" })))).toMatch(/^INVALID_INPUT/);
    expect((await create({ comment: "   " })).comment).toBeNull();
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, d.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.map((r) => [r.before, r.after]))).not.toContain("good...");
    expect(rows.find((r) => r.action === "reports.definition_created")!.after).toMatchObject({
      commentLength: 19,
      language: "en",
      groupId: null,
    });
  });

  it("validates group scope", async () => {
    const d = await create({ scope: "group", groupId });
    expect(d).toMatchObject({ scope: "group", groupId });
    const bad = (over: Record<string, unknown>) => codeOf(run(o.manager, "reports.definitions.create", base(over)));
    expect(await bad({ scope: "group" })).toMatch(/^INVALID_INPUT/); // no groupId
    expect(await bad({ scope: "group", groupId, locationIds: [o.locA1.id] })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ scope: "workspace", groupId })).toMatch(/^INVALID_INPUT/);
    expect(await bad({ scope: "group", groupId: groupB })).toMatch(/^NOT_FOUND/); // other workspace
    expect(await codeOf(run(other.owner, "reports.definitions.create", { ...base({ scope: "group", groupId }), workspaceId: other.wsA }))).toMatch(/^NOT_FOUND/);
    const lang = await codeOf(run(o.manager, "reports.definitions.create", base({ language: "fr" })));
    expect(lang).toMatch(/^INVALID_INPUT/);
  });
});

describe("runs with the new options", () => {
  it("a group report covers the members at run time; a deleted group fails the run", async () => {
    const d = await create({ scope: "group", groupId });
    const first = await generateText(d.id);
    expect(first.outcome).toBe("done");
    expect(first.text).toContain("Locations (1): Acme Dental");

    await db.insert(locationGroupMembers).values({ groupId, locationId: o.locA2.id, orgId: o.orgId });
    const second = await generateText(d.id);
    expect(second.text).toContain("Locations (2)");

    const [g] = await db.insert(locationGroups).values({ orgId: o.orgId, workspaceId: o.wsA, name: `Gone ${uniq()}` }).returning();
    const doomed = await create({ scope: "group", groupId: g!.id });
    await db.delete(locationGroups).where(eq(locationGroups.id, g!.id));
    const [after] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, doomed.id));
    expect(after!.groupId).toBeNull();
    const failed = await generateText(doomed.id);
    expect(failed.outcome).toBe("failed");
    expect(failed.row.error).toBe("group_missing");
  });

  it("prints Spanish labels and the comment; English keeps its strings", async () => {
    const es = await create({ language: "es", comment: "Las llamadas subieron. ¡Gracias!" });
    const t = (await generateText(es.id)).text;
    for (const s of ["Resultados clave", "Llamadas", "Una nota de Synectus Agency", "Las llamadas subieron. ¡Gracias!", "Periodo: 2026-09-01 to 2026-09-30"]) {
      expect(t).toContain(s);
    }
    const en = await create({ comment: "Calls are up." });
    const e = (await generateText(en.id)).text;
    for (const s of ["Key results", "Calls", "A note from Synectus Agency", "Calls are up."]) expect(e).toContain(s);
    const none = await create();
    expect((await generateText(none.id)).text).not.toContain("A note from");
  });

  it("a long comment wraps onto several lines and every word is printed", async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`); // 409 characters, under the 500 limit
    const d = await create({ comment: words.join(" ") });
    const t = (await generateText(d.id)).text;
    for (const w of words) expect(t).toContain(w);
    const noteLines = t.split("\n").filter((l) => l.startsWith("word"));
    expect(noteLines.length).toBeGreaterThan(1);
  });

  it("runs carry requestedByName (manual) or null (schedule)", async () => {
    const d = await create();
    const { runId } = await generateText(d.id);
    const got = (await run(o.viewerA, "reports.runs.get", { runId })) as { run: { requestedByName: string | null } };
    expect(got.run.requestedByName).toBe("T"); // makeOrg names every user "T"
    const list = (await run(o.viewerA, "reports.runs.list", { definitionId: d.id })) as { runs: { id: string; requestedByName: string | null }[] };
    expect(list.runs.find((r) => r.id === runId)!.requestedByName).toBe("T");
    await db.insert(reportRuns).values({ orgId: o.orgId, definitionId: d.id, periodStart: "2026-08-01", periodEnd: "2026-08-31", trigger: "schedule" });
    const list2 = (await run(o.viewerA, "reports.runs.list", { definitionId: d.id })) as { runs: { requestedByName: string | null }[] };
    expect(list2.runs.some((r) => r.requestedByName === null)).toBe(true);
  });
});
