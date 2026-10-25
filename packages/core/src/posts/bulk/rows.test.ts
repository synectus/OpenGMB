import { describe, expect, it } from "vitest";
import { bulkTemplateCsv } from "./columns";
import { buildBulkRows, type BulkLocation } from "./rows";

const loc = (id: string, name: string, over: Partial<BulkLocation["vars"]> = {}): BulkLocation => ({
  id,
  name,
  title: name,
  vars: { name, city: "Austin", phone: "+1 555 0100", address: "1 Main St, Austin, TX 78701", website: "https://acme.test", ...over },
});
const locations = [loc("l1", "Acme Austin"), loc("l2", "Acme Dallas", { city: "Dallas" }), loc("l3", "No City", { city: null })];
const ctx = { locations, timeZone: "America/Chicago", now: new Date("2026-10-20T12:00:00Z") };
const H = "location,type,summary,cta_type,cta_url,scheduled,image_url\n";

describe("buildBulkRows", () => {
  it("builds a draft per row with variables filled and quoted commas kept", () => {
    const r = buildBulkRows(H + 'Acme Austin,STANDARD,"Hi {name}, visit us in {city}",BOOK,https://x.test/{city},,\nacme dallas,,Plain,,,,', ctx);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.errors)).toEqual([[], []]);
    expect(r.rows[0]!.draft).toMatchObject({
      locationId: "l1",
      topicType: "STANDARD",
      summary: "Hi Acme Austin, visit us in Austin",
      cta: { actionType: "BOOK", url: "https://x.test/Austin" },
      scheduledFor: null,
    });
    expect(r.rows[1]!.draft).toMatchObject({ locationId: "l2", topicType: "STANDARD", summary: "Plain", cta: null });
  });
  it("reads the send time in the client's zone and rejects the past", () => {
    const r = buildBulkRows(H + "Acme Austin,,A,,,2026-12-01 09:00,\nAcme Austin,,B,,,2026-10-01 09:00,\nAcme Austin,,C,,,tomorrow,", ctx);
    expect(r.rows[0]!.draft!.scheduledFor).toBe("2026-12-01T15:00:00.000Z"); // CST is UTC-6
    expect(r.rows[1]!.errors[0]).toMatch(/past/);
    expect(r.rows[2]!.errors[0]).toMatch(/YYYY-MM-DD HH:MM/);
  });
  it("makes every problem a row error and still returns the good rows", () => {
    const r = buildBulkRows(
      H + [
        "Nowhere,,Hi,,,,",
        "Acme Austin,,Hi {nme},,,,",
        "No City,,Hello from {city},,,,",
        "Acme Austin,ALERT,x,,,,",
        "Acme Austin,,x,PUSH,,,",
        "Acme Austin,,x,,,,ftp://img",
        "Acme Austin,,,,,,",
        "Acme Austin,,ok,,,,",
      ].join("\n"),
      ctx,
    );
    const msgs = r.rows.map((x) => x.errors.join(" | "));
    expect(msgs[0]).toMatch(/No location named "Nowhere"/);
    expect(msgs[1]).toMatch(/Unknown variable \{nme\}/);
    expect(msgs[2]).toMatch(/\{city\} has no value for No City/);
    expect(msgs[3]).toMatch(/ALERT/);
    expect(msgs[4]).toMatch(/CTA type/);
    expect(msgs[5]).toMatch(/image/i);
    expect(msgs[6]).toMatch(/summary is empty/i);
    expect(msgs[7]).toBe("");
    expect(r.rows.map((x) => x.draft === null)).toEqual([true, true, true, true, true, true, true, false]);
  });
  it("matches a location by id and flags an ambiguous name", () => {
    const dup = [...locations, loc("l4", "Acme Austin")];
    const r = buildBulkRows(H + "l2,,x,,,,\nAcme Austin,,x,,,,", { ...ctx, locations: dup });
    expect(r.rows[0]!.draft!.locationId).toBe("l2");
    expect(r.rows[1]!.errors[0]).toMatch(/more than one/);
  });
  it("fails the file for a missing or unknown column, a duplicate column, or too many rows", () => {
    expect(buildBulkRows("summary\nx", ctx).errors[0]).toMatch(/"location" column/);
    expect(buildBulkRows("location,summary,colour\nAcme Austin,x,red", ctx).errors[0]).toMatch(/"colour"/);
    expect(buildBulkRows("location,text,summary\nAcme Austin,x,y", ctx).errors[0]).toMatch(/twice/);
    expect(buildBulkRows("location,summary\nAcme Austin,x\nAcme Austin,y", { ...ctx, maxRows: 1 }).errors[0]).toMatch(/at most 1/);
    expect(buildBulkRows("", ctx).errors[0]).toMatch(/empty/i);
    expect(buildBulkRows("location,summary", ctx).errors[0]).toMatch(/no rows/i);
  });
  it("builds event and offer fields and checks their formats", () => {
    const h = "location,type,summary,event_title,event_start_date,event_end_date,coupon_code,terms\n";
    const r = buildBulkRows(h + 'Acme Austin,OFFER,Deal,Sale {city},2026-12-01,2026-12-05,SAVE,"Terms, apply"\nAcme Austin,EVENT,E,T,12/01/2026,2026-12-05,,', ctx);
    expect(r.rows[0]!.draft).toMatchObject({
      topicType: "OFFER",
      event: { title: "Sale Austin", startDate: "2026-12-01", endDate: "2026-12-05" },
      offer: { couponCode: "SAVE", termsConditions: "Terms, apply" },
    });
    expect(r.rows[1]!.errors[0]).toMatch(/event_start_date/);
    const mixed = buildBulkRows(h + "Acme Austin,,x,T,2026-12-01,2026-12-02,SAVE,", ctx);
    expect(mixed.rows[0]!.errors).toEqual(["event_* columns need type EVENT or OFFER", "coupon_code, redeem_url and terms need type OFFER"]);
  });
  it("accepts the downloadable template", () => {
    const r = buildBulkRows(bulkTemplateCsv(ctx.now), { ...ctx, locations: [loc("a", "Acme Dental Austin"), loc("b", "Acme Dental Dallas")] });
    expect(r.errors).toEqual([]);
    expect(r.rows.flatMap((x) => x.errors)).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });
});

describe("cta type spelling", () => {
  it("accepts a plain-words button name", () => {
    const r = buildBulkRows("location,summary,cta_type,cta_url\nAcme Austin,x,Learn more,https://a.test", ctx);
    expect(r.rows[0]!.draft!.cta).toEqual({ actionType: "LEARN_MORE", url: "https://a.test" });
  });
});
