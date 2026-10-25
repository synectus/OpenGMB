import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reportRuns, reviews } from "@opengmb/db";
import { executeAction } from "./executor";
import { prepareReportLogo } from "./reports/logo";
import { renderReviewReportPdf } from "./reports/review-pdf";
import { REPORT_GENERATE_QUEUE, processReportRun } from "./reports/run";
import { reviewStats, type ReviewStats } from "./reviews/stats";
import { db, makeOrg, sql, uniq, type Org } from "./performance-fixture";

const SECRET_COMMENT = "SECRET_COMMENT back pain";
const SECRET_NAME = "SECRET_NAME Rivera";
const SECRET_REPLY = "SECRET_REPLY we are sorry";
const boss = new PgBoss(process.env.DATABASE_URL_TEST!);
const NOW = new Date("2026-10-12T14:00:00Z");
const RANGE = { from: "2026-09-01", to: "2026-09-30" };

/** Text drawn on a pdf-lib page: hex strings before `Tj`, in (possibly deflated) content streams. */
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

let o: Org;
async function put(locationId: string, rating: number, created: string, reply?: { at: string; state?: string }) {
  const at = new Date(created);
  await db.insert(reviews).values({
    orgId: o.orgId,
    workspaceId: o.wsA,
    locationId,
    googleReviewName: `accounts/1/locations/1/reviews/${uniq()}`,
    reviewerDisplayName: SECRET_NAME,
    starRating: rating,
    comment: SECRET_COMMENT,
    createTime: at,
    updateTime: at,
    replyComment: reply ? SECRET_REPLY : null,
    replyUpdateTime: reply ? new Date(reply.at) : null,
    replyState: reply?.state ?? null,
  });
}

beforeAll(async () => {
  await boss.start();
  await boss.createQueue(REPORT_GENERATE_QUEUE);
  o = await makeOrg();
  // Acme Dental: 5 stars replied after 2 h, 1 star unreplied, 4 stars replied after 24 h.
  await put(o.locA1.id, 5, "2026-09-02T10:00:00Z", { at: "2026-09-02T12:00:00Z" });
  await put(o.locA1.id, 1, "2026-09-05T10:00:00Z");
  await put(o.locA1.id, 4, "2026-09-10T10:00:00Z", { at: "2026-09-11T10:00:00Z" });
  // Acme Dental North: a 3 star whose reply Google rejected (not a visible reply), a 5 star replied after 1 h.
  await put(o.locA2.id, 3, "2026-09-15T10:00:00Z", { at: "2026-09-15T12:00:00Z", state: "REJECTED" });
  await put(o.locA2.id, 5, "2026-09-20T10:00:00Z", { at: "2026-09-20T11:00:00Z" });
  // Previous period (2026-08-02 to 2026-08-31): one unreplied 2 star.
  await put(o.locA1.id, 2, "2026-08-20T10:00:00Z");
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});

const locs = () => [
  { id: o.locA1.id, label: "Acme Dental" },
  { id: o.locA2.id, label: "Acme Dental North" },
];

describe("reviewStats", () => {
  it("counts, rates and medians for the period and the one before", async () => {
    const s = await reviewStats(db, { locations: locs(), range: RANGE });
    expect(s.newReviews).toBe(5);
    expect(s.previousNewReviews).toBe(1);
    expect(s.averageRating).toBeCloseTo(3.6, 5);
    expect(s.previousAverageRating).toBe(2);
    expect(s.replyRate).toBeCloseTo(0.6, 5); // the rejected reply does not count
    expect(s.previousReplyRate).toBe(0);
    expect(s.medianHoursToReply).toBeCloseTo(2, 5); // 1 h, 2 h, 24 h
    expect(s.starMix).toEqual([1, 0, 1, 1, 2]);
    expect(s.trend.map((t) => t.month)).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    expect(s.trend[5]).toMatchObject({ count: 5 });
    expect(s.trend[4]).toMatchObject({ count: 1, averageRating: 2 });
    expect(s.trend[0]).toMatchObject({ count: 0, averageRating: null });
  });

  it("splits by location, zero-filled and sorted by label", async () => {
    const s = await reviewStats(db, { locations: [...locs(), { id: o.locB.id, label: "Other Co" }], range: RANGE });
    expect(s.byLocation.map((l) => l.label)).toEqual(["Acme Dental", "Acme Dental North", "Other Co"]);
    expect(s.byLocation[0]).toMatchObject({ newReviews: 3 });
    expect(s.byLocation[0]!.replyRate).toBeCloseTo(2 / 3, 5);
    expect(s.byLocation[0]!.medianHoursToReply).toBeCloseTo(13, 5);
    expect(s.byLocation[1]).toMatchObject({ newReviews: 2, replyRate: 0.5, medianHoursToReply: 1 });
    expect(s.byLocation[2]).toMatchObject({ newReviews: 0, averageRating: null, replyRate: null });
  });

  it("source canary: stats.ts never names a text column (and the canary can still match)", () => {
    const src = readFileSync(new URL("./reviews/stats.ts", import.meta.url), "utf8");
    expect(src).toMatch(/reviews\.starRating/); // positive canary: the scan is reading the right file
    expect(src).not.toMatch(/reviews\.comment|reviewerDisplayName|reviews\.replyComment/);
  });
});

describe("the review report run", () => {
  it("stores figures and the location name, never review text, reviewer names or reply text", async () => {
    const created = (await executeAction(db, o.manager, "reports.definitions.create", {
      workspaceId: o.wsA,
      name: "Acme reviews, monthly",
      kind: "reviews",
      scope: "workspace",
      locationIds: [],
      period: "custom",
      customFrom: RANGE.from,
      customTo: RANGE.to,
      schedule: "none",
      recipients: [],
      branding: { agencyName: "Synectus Agency" },
    })) as { definition: { id: string } };
    const gen = (await executeAction(db, o.manager, "reports.generate", {
      definitionId: created.definition.id,
    })) as { runId: string };
    expect(await processReportRun(db, gen.runId, { now: NOW })).toBe("done");

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, gen.runId));
    const content = run!.content as { kind: string; stats: ReviewStats };
    expect(content.kind).toBe("reviews");
    expect(content.stats.newReviews).toBe(5);
    const json = JSON.stringify(content);
    expect(json).toContain("Acme Dental"); // positive canary
    for (const secret of [SECRET_COMMENT, SECRET_NAME, SECRET_REPLY]) expect(json).not.toContain(secret);

    const text = pdfText(Buffer.from(run!.pdf!));
    expect(text).toContain("Acme Dental");
    expect(text).toContain("5 stars");
    for (const secret of [SECRET_COMMENT, SECRET_NAME, SECRET_REPLY]) expect(text).not.toContain(secret);
  });
});

describe("the review PDF", () => {
  const stats: ReviewStats = {
    newReviews: 4, previousNewReviews: 2, averageRating: 4.25, previousAverageRating: 4,
    replyRate: 0.5, previousReplyRate: 0.25, medianHoursToReply: 30, starMix: [0, 0, 1, 1, 2],
    trend: [{ month: "2026-09", count: 4, averageRating: 4.25 }],
    byLocation: [{ locationId: "l1", label: "Acme Dental", newReviews: 4, averageRating: 4.25, replyRate: 0.5, medianHoursToReply: 30 }],
  };
  const input = {
    title: "Acme reviews", branding: {}, periodLabel: "2026-09-01 to 2026-09-30",
    comparisonLabel: "2026-08-02 to 2026-08-31", locationLabels: ["Acme Dental"], stats,
    generatedAt: NOW,
  };
  it("prints English labels and 'N stars'", async () => {
    const text = pdfText(Buffer.from(await renderReviewReportPdf(input)));
    expect(text).toContain("Star mix");
    expect(text).toContain("5 stars");
    expect(text).toContain("Time to reply");
  });
  it("draws the logo in the header only when given one", async () => {
    const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#cc3300" } }).png().toBuffer();
    const logo = (await prepareReportLogo(png))!;
    const images = async (pdf: Uint8Array) => {
      let n = 0;
      for (const [, o] of (await PDFDocument.load(pdf)).context.enumerateIndirectObjects()) {
        if (o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) n++;
      }
      return n;
    };
    expect(await images(await renderReviewReportPdf(input))).toBe(0);
    expect(await images(await renderReviewReportPdf({ ...input, logo }))).toBe(1);
  });
  it("prints Spanish labels", async () => {
    const text = pdfText(Buffer.from(await renderReviewReportPdf({ ...input, language: "es" })));
    expect(text).toContain("Mezcla de estrellas");
    expect(text).toContain("5 estrellas");
  });
});
