import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import {
  CHANGE_TONE,
  diffRows,
  foundLine,
  parseStatus,
  resolvedLine,
  revertLine,
  revertLink,
  revertTone,
  showValue,
  statusPills,
  structuredSides,
  type ChangeData,
} from "./changes";

const ID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const CS = "33333333-3333-4333-8333-333333333333";
const change = (over: Partial<ChangeData> = {}): ChangeData => ({
  id: ID,
  locationId: "l",
  locationName: "Rivermoor Main St",
  workspaceId: WS,
  detectedAt: "2026-10-18T03:30:12.000Z",
  source: "nightly",
  fieldPaths: ["websiteUri"],
  before: { fields: { websiteUri: "https://rivermoorpainclinic.example" }, attributes: {} },
  after: { fields: { websiteUri: null }, attributes: {} },
  googleSuggested: false,
  status: "open",
  resolvedBy: null,
  resolvedByName: null,
  resolvedAt: null,
  revertChangeSetId: null,
  revertChangeSetStatus: null,
  revertChangeSetSurface: null,
  can: { accept: true, revert: true, dismiss: true },
  ...over,
});

describe("status filter", () => {
  it("defaults to open and accepts all", () => {
    expect(parseStatus(undefined)).toBe("open");
    expect(parseStatus("all")).toBe("all");
    expect(parseStatus("dismissed")).toBe("dismissed");
    expect(parseStatus("rejected")).toBe("open");
  });
  it("pills: only Open carries a count", () => {
    expect(statusPills(2).map((p) => p.label)).toEqual(["Open (2)", "Accepted", "Reverted", "Dismissed", "All"]);
  });
  it("tones", () => {
    expect(CHANGE_TONE.open).toBe("warn");
    expect(CHANGE_TONE.accepted).toBe("good");
  });
});

describe("values and rows", () => {
  it("canvas words for nothing and for structures", () => {
    expect(showValue(null)).toBe("(empty)");
    expect(showValue("x")).toBe("x");
    expect(showValue({ periods: [] })).toBe('{"periods":[]}');
    expect(showValue("y".repeat(500))).toHaveLength(500); // text is never cut
    expect(showValue({ t: "y".repeat(500) })).toHaveLength(403); // JSON is cut at 400 plus "..."
  });
  it("a field missing from one side is (not shown); attributes are read from attributes", () => {
    const c = change({
      fieldPaths: ["websiteUri", "attributes/has_wifi", "adWordsLocationExtensions"],
      before: { fields: { websiteUri: "a" }, attributes: { "attributes/has_wifi": { values: [true] } } },
      after: { fields: { websiteUri: null }, attributes: {} },
    });
    expect(diffRows(c)).toEqual([
      { field: "Website", before: "a", after: "(empty)", mono: false },
      { field: "Attribute: Has wifi", before: '{"values":[true]}', after: "(not shown)", mono: true },
      { field: "Ad words location extensions", before: "(not shown)", after: "(not shown)", mono: false },
    ]);
  });
});

describe("structuredSides", () => {
  const c = {
    before: { fields: { websiteUri: "a", serviceArea: { businessType: "X" } }, attributes: {} },
    after: { fields: { websiteUri: "b", serviceArea: { businessType: "Y" } }, attributes: {} },
  } as unknown as Pick<ChangeData, "before" | "after">;
  it("returns both sides for a structure, null for plain values and missing paths", () => {
    expect(structuredSides(c, "serviceArea")).toEqual({ before: { businessType: "X" }, after: { businessType: "Y" } });
    expect(structuredSides(c, "websiteUri")).toBeNull();
    expect(structuredSides(c, "title")).toBeNull();
  });
});

const utc = makeTimeFormat({ zones: [{ id: "WS", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "WS" });
const ist = makeTimeFormat({ zones: [{ id: "WS", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "WS" });

describe("lines", () => {
  it("found line names the source, in the client's zone", () => {
    expect(foundLine(change(), utc)).toBe("Found 2026-10-18 03:30 (nightly snapshot)");
    expect(foundLine(change({ source: "push" }), utc)).toBe("Found 2026-10-18 03:30 (Google notification)");
    expect(foundLine(change(), ist)).toBe("Found 18/10/2026 09:00 (nightly snapshot)");
  });
  it("resolved line for accepted and dismissed, nothing otherwise", () => {
    const at = "2026-10-16T10:12:00.000Z";
    expect(resolvedLine(change({ status: "accepted", resolvedByName: "Priya", resolvedAt: at }), utc)).toBe(
      "Accepted by Priya on 2026-10-16 · nothing was written to Google",
    );
    expect(resolvedLine(change({ status: "dismissed", resolvedByName: null, resolvedAt: at }), utc)).toBe(
      "Dismissed by a team member on 2026-10-16 · nothing was written to Google",
    );
    expect(resolvedLine(change(), utc)).toBeNull();
    expect(resolvedLine(change({ status: "accepted", resolvedByName: "Priya", resolvedAt: "2026-10-16T20:00:00.000Z" }), ist)).toBe(
      "Accepted by Priya on 17/10/2026 · nothing was written to Google",
    );
  });
  it("revert line and tone", () => {
    expect(revertLine("pending_approval")).toBe("Revert change set: pending approval");
    expect(revertLine("queued")).toBe("Revert change set: queued · Waiting for the worker");
    expect(revertTone("failed")).toBe("bad");
    expect(revertTone("approved")).toBe("good");
    expect(revertTone("queued")).toBe("info");
  });
});

describe("revert link", () => {
  it("pending: Open Approvals on the change set", () => {
    const l = revertLink(change({ revertChangeSetId: CS, revertChangeSetStatus: "pending_approval" }))!;
    expect(l.label).toBe("Open Approvals");
    const u = new URL(l.href, "http://x");
    expect(u.pathname).toBe("/approvals");
    expect(u.searchParams.get("tab")).toBe("changeset");
    expect(u.searchParams.get("item")).toBe(`changeset:${CS}`);
  });
  it("after approval: Bulk edit's change sets for that workspace, where Apply lives", () => {
    for (const s of ["approved", "queued", "applied", "failed", "cancelled"]) {
      expect(revertLink(change({ revertChangeSetId: CS, revertChangeSetStatus: s }))).toEqual({
        href: `/locations/bulk-edit?ws=${WS}#change-sets`,
        label: "Open change sets",
      });
    }
  });
  it("no revert, no link", () => {
    expect(revertLink(change())).toBeNull();
  });
});
