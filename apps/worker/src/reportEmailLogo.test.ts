import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, locations, organizations, reportDefinitions, reportRuns, storedFiles, workspaces, users, type Db } from "@opengmb/db";
import type { EmailMessage } from "./digest";
import { LOGO_CID, runMonthlyReports } from "./reports";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date("2026-10-01T14:00:00Z");
const DOMAIN = `${uniq()}.example.test`;
afterAll(() => sql.end());

/** A solid-colour RGB PNG, built by hand so the worker needs no image library. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

type Org = { orgId: string; defId: string; to: string; logo: Buffer | null };
const orgs: Record<"a" | "b" | "none", Org> = {} as never;

async function makeOrg(key: "a" | "b" | "none", logo: Buffer | null) {
  const [org] = await db.insert(organizations).values({ name: `org-${key}-${uniq()}` }).returning();
  const orgId = org!.id;
  const [ws] = await db.insert(workspaces).values({ orgId, name: `w-${uniq()}` }).returning();
  const userId = `u-${uniq()}`;
  await db.insert(users).values({ id: userId, name: "T", email: `${userId}@example.test` });
  await db.insert(locations).values({ orgId, workspaceId: ws!.id, name: `locations/${uniq()}`, title: "Acme" });
  const to = `${key}@${DOMAIN}`;
  const [def] = await db
    .insert(reportDefinitions)
    .values({ orgId, workspaceId: ws!.id, scope: "workspace", period: "last_month", createdBy: userId, name: `Monthly ${key}`, schedule: "monthly", recipients: [to] })
    .returning();
  if (logo) {
    await db.insert(storedFiles).values({
      orgId, workspaceId: null, kind: "logo", contentType: "image/png", byteSize: logo.length,
      sha256: createHash("sha256").update(logo).digest("hex"), bytes: logo, createdBy: userId,
    });
  }
  orgs[key] = { orgId, defId: def!.id, to, logo };
}

/** Image XObjects in a PDF (their dictionaries are never inside compressed streams). */
const imageCount = (pdf: Uint8Array) => (Buffer.from(pdf).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;

const sent: EmailMessage[] = [];
beforeAll(async () => {
  await makeOrg("a", solidPng(600, 200, [204, 51, 0]));
  await makeOrg("b", solidPng(300, 80, [0, 51, 204]));
  await makeOrg("none", null);
  await runMonthlyReports(db as Db, {
    sendEmail: async (m) => { sent.push(m); },
    apiKey: "re_test",
    from: "OpenGMB <notifications@ci.invalid>",
    appUrl: "https://app.test",
    now: () => NOW,
    orgIds: [orgs.a.orgId, orgs.b.orgId, orgs.none.orgId],
  });
});

const to = (k: keyof typeof orgs) => sent.filter((m) => m.to === orgs[k].to);

describe("scheduled report email and PDF carry the agency logo", () => {
  it("sends one email per recipient, with the share link, and only to its own recipients", () => {
    for (const k of ["a", "b", "none"] as const) {
      expect(to(k)).toHaveLength(1);
      expect(to(k)[0]!.text).toMatch(/https:\/\/app\.test\/r\/[A-Za-z0-9_-]{43}/);
    }
    expect(sent).toHaveLength(3);
  });

  it("attaches the org's own logo inline and references it from the html", () => {
    for (const k of ["a", "b"] as const) {
      const m = to(k)[0]!;
      expect(m.attachments).toHaveLength(1);
      const att = m.attachments![0]!;
      expect(att).toMatchObject({ contentId: LOGO_CID, contentType: "image/png" });
      expect(m.html).toContain(`src="cid:${LOGO_CID}"`);
      // A shrunk copy of this org's own logo (aspect kept), not the other org's.
      const png = Buffer.from(att.content, "base64");
      expect(pngSize(png)).toEqual(k === "a" ? [288, 96] : [300, 80]);
      expect(att.content.length).toBeLessThan(40_000);
    }
  });

  it("an org without a logo gets no attachment and no image tag", () => {
    const m = to("none")[0]!;
    expect(m.attachments).toBeUndefined();
    expect(m.html).not.toContain("cid:");
  });

  it("the generated PDF has the logo image, and none for the org without one", async () => {
    for (const k of ["a", "b", "none"] as const) {
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.definitionId, orgs[k].defId));
      expect(run!.status).toBe("done");
      expect(imageCount(run!.pdf!)).toBe(k === "none" ? 0 : 1);
    }
  });
});
