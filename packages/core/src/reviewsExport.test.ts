import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  organizations,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { REVIEWS_CONFIG } from "./config/reviews";
import { executeAction } from "./executor";
import { seedMockGoogleConnection } from "./google/dev-seed";
import { csvField } from "./reviews/export";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqDigits = () => `${Date.now()}${randomInt(100_000_000, 1_000_000_000)}`;
const SECRET = "my back pain and my diabetes after the accident, Dr Smith";

type Out = { filename: string; csv: string; rowCount: number; truncated: boolean };
const BOM = "﻿";
const HEADER = [
  "Review date (UTC)",
  "Location",
  "Stars",
  "Reviewer",
  "Review",
  "Reply",
  "Reply date (UTC)",
  "Google reply state",
  "Needs reply",
];

/** Minimal RFC 4180 parser, so the tests check what a spreadsheet would read back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  return rows;
}

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const mkUser = async (role: "owner" | "client_viewer", workspaceId?: string) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return { id, email: `${id}@example.test` };
  };
  const owner = await mkUser("owner");
  const viewer = await mkUser("client_viewer", a!.id);
  const actor = (u: { id: string }) =>
    loadActor(db, { userId: u.id, surface: "ui", actorType: "user" });
  const { connectionId } = await seedMockGoogleConnection(db, owner.email);
  const mkLoc = async (workspaceId: string, name: string) => {
    const n = uniqDigits();
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        name,
        googleAccountName: `accounts/9${n.slice(-8)}`,
        googleLocationId: `locations/9${n.slice(-10)}`,
        connectionId,
        status: "active",
      })
      .returning();
    return l!;
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await actor(owner),
    viewer: await actor(viewer),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;
type Loc = Awaited<ReturnType<Org["mkLoc"]>>;

const run = (actor: Actor, input: unknown = {}) =>
  executeAction(db, actor, "reviews.export", input) as Promise<Out>;

let seq = 0;
async function mkReview(
  loc: Loc,
  o: {
    rating?: number | null;
    reply?: string | null;
    replyState?: string | null;
    createTime?: string;
    comment?: string | null;
    reviewer?: string | null;
    anonymous?: boolean;
  } = {},
) {
  const createTime = new Date(o.createTime ?? "2026-09-01T00:00:00Z");
  await db.insert(reviews).values({
    orgId: loc.orgId,
    workspaceId: loc.workspaceId,
    locationId: loc.id,
    googleReviewName: `accounts/1/locations/1/reviews/x${uniq()}-${seq++}`,
    reviewerDisplayName: o.reviewer === undefined ? "Rev" : o.reviewer,
    reviewerIsAnonymous: o.anonymous ?? false,
    starRating: o.rating === undefined ? 5 : o.rating,
    comment: o.comment === undefined ? "text" : o.comment,
    createTime,
    updateTime: createTime,
    replyComment: o.reply ?? null,
    replyUpdateTime: o.reply ? new Date("2026-09-02T10:30:00Z") : null,
    replyState: o.replyState ?? null,
  });
}

afterAll(async () => {
  await sql.end();
});

describe("csvField", () => {
  it("quotes commas, quotes, CR and LF and doubles inner quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("l1\nl2")).toBe('"l1\nl2"');
    expect(csvField("l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(csvField(null)).toBe("");
    expect(csvField(4)).toBe("4");
  });
  it("prefixes a single quote when a field starts with = + - @ tab or CR", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("\rx")).toBe('"\'\rx"');
    expect(csvField("a=b")).toBe("a=b");
    // the prefixed field is still quoted when it needs it
    expect(csvField('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });
  it("keeps unicode intact", () => {
    expect(csvField("Zoë 日本語 ★")).toBe("Zoë 日本語 ★");
  });
});

describe("reviews.export", () => {
  let org: Org;
  let other: Org;
  let locA: Loc;
  let locB: Loc;

  beforeAll(async () => {
    org = await makeOrg();
    other = await makeOrg();
    locA = await org.mkLoc(org.a, 'Clinic "North", Main');
    locB = await org.mkLoc(org.b, "Clinic B");
    const foreign = await other.mkLoc(other.a, "Foreign");
    await mkReview(foreign, { comment: "foreign review" });
  });

  it("writes a BOM, the header, and one escaped row per review", async () => {
    const w = await org.mkLoc(org.a, 'Esc, "Q"');
    await mkReview(w, {
      createTime: "2020-01-01T00:00:00Z",
      rating: 4,
      reviewer: "Zoë Müller",
      comment: 'Great, "really"\nsecond line 日本語',
      reply: '=HYPERLINK("http://evil","x")',
      replyState: "APPROVED",
    });
    const out = await run(org.owner, { locationIds: [w.id] });
    expect(out.csv.startsWith(BOM)).toBe(true);
    expect(out.csv.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(out.csv.slice(1));
    expect(rows[0]).toEqual(HEADER);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      "2020-01-01T00:00:00.000Z",
      'Esc, "Q"',
      "4",
      "Zoë Müller",
      'Great, "really"\nsecond line 日本語',
      '\'=HYPERLINK("http://evil","x")',
      "2026-09-02T10:30:00.000Z",
      "APPROVED",
      "no",
    ]);
    expect(out.rowCount).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.filename).toMatch(/^reviews-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("uses Anonymous, a blank rating and blank reply columns where there is no data", async () => {
    const w = await org.mkLoc(org.a, "Anon");
    await mkReview(w, { anonymous: true, reviewer: "A Google User", rating: null, comment: null });
    const rows = parseCsv((await run(org.owner, { locationIds: [w.id] })).csv.slice(1));
    expect(rows[1]!.slice(2)).toEqual(["", "Anonymous", "", "", "", "", "yes"]);
  });

  it("respects the reviews.list filters, and replied=false includes REJECTED replies", async () => {
    const w = await org.mkLoc(org.a, "Filt");
    await mkReview(w, { rating: 5, reply: "thanks", replyState: "APPROVED", comment: "r-ok" });
    await mkReview(w, { rating: 1, comment: "r-none" });
    await mkReview(w, { rating: 2, reply: "sorry", replyState: "REJECTED", comment: "r-rej" });
    await mkReview(w, { rating: 1, createTime: "2025-01-01T00:00:00Z", comment: "r-old" });
    const texts = async (input: Record<string, unknown>) =>
      parseCsv((await run(org.owner, { locationIds: [w.id], ...input })).csv.slice(1))
        .slice(1)
        .map((r) => r[4]!)
        .sort();
    expect(await texts({})).toEqual(["r-none", "r-ok", "r-old", "r-rej"]);
    expect(await texts({ replied: false })).toEqual(["r-none", "r-old", "r-rej"]);
    expect(await texts({ replied: true })).toEqual(["r-ok"]);
    expect(await texts({ ratings: [1] })).toEqual(["r-none", "r-old"]);
    expect(await texts({ from: "2026-01-01T00:00:00Z" })).toEqual(["r-none", "r-ok", "r-rej"]);
    expect(await texts({ to: "2026-01-01T00:00:00Z" })).toEqual(["r-old"]);
    const rej = parseCsv(
      (await run(org.owner, { locationIds: [w.id], ratings: [2] })).csv.slice(1),
    );
    expect(rej[1]!.slice(7)).toEqual(["REJECTED", "yes"]);
  });

  it("client roles only get their own workspace; other orgs never leak", async () => {
    await mkReview(locA, { comment: "in-a" });
    await mkReview(locB, { comment: "in-b" });
    const viewer = await run(org.viewer, {});
    expect(viewer.csv).toContain("in-a");
    expect(viewer.csv).not.toContain("in-b");
    expect(viewer.csv).not.toContain("foreign review");
    const owner = await run(org.owner, {});
    expect(owner.csv).toContain("in-b");
    expect(owner.csv).not.toContain("foreign review");
    await expect(run(org.viewer, { workspaceId: org.b })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("caps the rows at the configured maximum and flags truncated", async () => {
    const cap = REVIEWS_CONFIG.exportMaxRows;
    const w = await org.mkLoc(org.a, "Cap");
    const base = {
      orgId: w.orgId,
      workspaceId: w.workspaceId,
      locationId: w.id,
      starRating: 5,
      createTime: new Date("2026-01-01T00:00:00Z"),
      updateTime: new Date("2026-01-01T00:00:00Z"),
    };
    const rowsFor = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({
        ...base,
        googleReviewName: `accounts/1/locations/1/reviews/cap-${w.id}-${from + i}`,
      }));
    for (let i = 0; i < cap; i += 2000) {
      await db.insert(reviews).values(rowsFor(i, Math.min(i + 2000, cap)));
    }
    const exact = await run(org.owner, { locationIds: [w.id] });
    expect(exact.rowCount).toBe(cap);
    expect(exact.truncated).toBe(false);
    await db.insert(reviews).values(rowsFor(cap, cap + 1));
    const over = await run(org.owner, { locationIds: [w.id] });
    expect(over.rowCount).toBe(cap);
    expect(over.truncated).toBe(true);
    expect(parseCsv(over.csv.slice(1))).toHaveLength(cap + 1);
  }, 60_000);

  it("audits the export with filters and counts, never review text", async () => {
    const w = await org.mkLoc(org.a, "Aud");
    await mkReview(w, { comment: SECRET, reply: SECRET });
    await run(org.owner, { locationIds: [w.id], ratings: [5] });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "reviews.exported")));
    expect(rows.length).toBeGreaterThan(0);
    const mine = rows.find((r) => JSON.stringify(r.after).includes(w.id))!;
    expect(mine.after).toMatchObject({ rowCount: 1, truncated: false, ratings: [5] });
    expect(JSON.stringify(rows)).not.toContain("diabetes");
  });
});
