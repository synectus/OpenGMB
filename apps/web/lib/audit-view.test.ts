import { describe, expect, it } from "vitest";
import {
  auditName,
  AUDIT_PAGE,
  AUDIT_SURFACES,
  actorLabel,
  auditHref,
  changeJson,
  olderBefore,
  pageNote,
  parseBefore,
  parseSurface,
  surfaceLabel,
} from "./audit-view";

describe("surfaces", () => {
  it("covers the four stored surfaces (denominator 4)", () => {
    expect(AUDIT_SURFACES.map((s) => s.key)).toEqual(["ui", "mcp", "worker", "cli"]);
    expect(surfaceLabel("ui")).toBe("App");
    expect(surfaceLabel("mcp")).toBe("API token");
    expect(surfaceLabel("cli")).toBe("Command line");
    expect(surfaceLabel("other")).toBe("other");
  });

  it("parses only known surfaces and positive whole ids", () => {
    expect(parseSurface("mcp")).toBe("mcp");
    expect(parseSurface("email")).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
    expect(parseBefore("1234")).toBe(1234);
    expect(parseBefore("0")).toBeUndefined();
    expect(parseBefore("12abc")).toBeUndefined();
    expect(parseBefore(undefined)).toBeUndefined();
  });
});

describe("auditHref", () => {
  it("keeps filters, drops empty ones", () => {
    expect(auditHref({})).toBe("/audit");
    expect(auditHref({ surface: "mcp", actor: "u-1", before: 50 })).toBe(
      "/audit?surface=mcp&actor=u-1&before=50",
    );
    expect(auditHref({ actor: "" })).toBe("/audit");
  });
});

describe("paging", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 1000 - i }));

  it("offers Older only when one more row than a page came back", () => {
    expect(olderBefore(rows(AUDIT_PAGE + 1), AUDIT_PAGE)).toBe(1000 - (AUDIT_PAGE - 1));
    expect(olderBefore(rows(AUDIT_PAGE), AUDIT_PAGE)).toBeNull();
    expect(olderBefore([], AUDIT_PAGE)).toBeNull();
  });

  it("says which rows are shown", () => {
    expect(pageNote(undefined, 50)).toBe("Showing the newest 50 rows.");
    expect(pageNote(1234, 50)).toBe("Showing 50 rows older than #1234.");
    expect(pageNote(undefined, 1)).toBe("Showing the newest 1 row.");
    expect(pageNote(undefined, 0)).toBe("");
  });
});

describe("actorLabel and changeJson", () => {
  it("names people, marks token rows, and says System for system rows", () => {
    expect(actorLabel({ actorType: "user", actorName: "Perry", actorUserId: "u1" })).toBe("Perry");
    expect(actorLabel({ actorType: "api_token", actorName: "Perry", actorUserId: "u1" })).toBe(
      "Perry (API token)",
    );
    expect(actorLabel({ actorType: "system", actorName: null, actorUserId: null })).toBe("System");
    expect(actorLabel({ actorType: "user", actorName: null, actorUserId: "u-deleted" })).toBe("u-deleted");
  });

  it("pretty-prints a change and says Nothing for a missing side", () => {
    expect(changeJson({ status: "applied" })).toBe('{\n  "status": "applied"\n}');
    expect(changeJson(null)).toBe("Nothing");
    expect(changeJson(undefined)).toBe("Nothing");
  });
});

describe("auditName", () => {
  it("shows the client word for stored workspace names", () => {
    expect(auditName("workspace.create")).toBe("client.create");
    expect(auditName("workspace")).toBe("client");
    expect(auditName("review.reply")).toBe("review.reply");
  });
});
