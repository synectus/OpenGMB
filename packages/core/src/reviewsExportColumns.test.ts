import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, reviews } from "@opengmb/db";
import { executeAction } from "./executor";
import { codeOf, db, makeOrg, sql, uniq } from "./performance-fixture";

type Out = { filename: string; csv: string; rowCount: number; truncated: boolean };
const SECRET = "my back pain and my diabetes";

afterAll(async () => {
  await sql.end();
});

async function seed() {
  const o = await makeOrg();
  const at = new Date("2026-09-01T10:00:00Z");
  await db.insert(reviews).values({
    orgId: o.orgId,
    workspaceId: o.wsA,
    locationId: o.locA1.id,
    googleReviewName: `accounts/1/locations/1/reviews/${uniq()}`,
    reviewerDisplayName: "Pat Reviewer",
    starRating: 4,
    comment: SECRET,
    createTime: at,
    updateTime: at,
  });
  return o;
}
const exp = (o: Awaited<ReturnType<typeof seed>>, input: Record<string, unknown> = {}) =>
  executeAction(db, o.owner, "reviews.export", input) as Promise<Out>;

describe("reviews.export columns", () => {
  it("without columns keeps the nine default columns, reviewer included", async () => {
    const o = await seed();
    const { csv } = await exp(o);
    const header = csv.replace("﻿", "").split("\r\n")[0];
    expect(header).toBe(
      "Review date (UTC),Location,Stars,Reviewer,Review,Reply,Reply date (UTC),Google reply state,Needs reply",
    );
    expect(csv).toContain("Pat Reviewer");
  });

  it("with columns emits only those, in canonical order, and leaves text and names out", async () => {
    const o = await seed();
    const { csv } = await exp(o, { columns: ["stars", "date", "location"] });
    const lines = csv.replace("﻿", "").split("\r\n");
    expect(lines[0]).toBe("Review date (UTC),Location,Stars");
    expect(lines[1]).toMatch(/^2026-09-01T10:00:00\.000Z,locations\/[^,]+,4$/);
    expect(csv).not.toContain(SECRET);
    expect(csv).not.toContain("Pat Reviewer");
  });

  it("refuses an empty or unknown column list", async () => {
    const o = await seed();
    expect(await codeOf(exp(o, { columns: [] }))).toMatch(/^INVALID_INPUT/);
    expect(await codeOf(exp(o, { columns: ["password"] }))).toMatch(/^INVALID_INPUT/);
  });

  it("records the columns, never the text, in the audit row", async () => {
    const o = await seed();
    await exp(o, { columns: ["date", "stars"] });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "reviews.exported")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ columns: ["date", "stars"], rowCount: 1 });
    expect(JSON.stringify(rows[0]!.after)).not.toContain(SECRET);
  });
});
