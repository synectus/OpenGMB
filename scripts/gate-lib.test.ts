import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dbUrlFor,
  docsOnlyDecision,
  findReportLine,
  parsePlaywrightJson,
  parseVitestJson,
  requirePositive,
} from "./gate-lib.mjs";

const fixture = (n: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

// The canary: known-positive fixtures with known counts. If these stop matching, the parser is
// broken regardless of what it reports for a real run.
describe("gate count parsing", () => {
  it("counts a known vitest report", () => {
    expect(parseVitestJson(fixture("vitest-ok.json"))).toEqual({ tests: 7, files: 3, failed: 1 });
  });
  it("counts a known Playwright report, walking nested suites", () => {
    expect(parsePlaywrightJson(fixture("playwright-ok.json"))).toEqual({
      tests: 4,
      failed: 1,
      skipped: 1,
    });
  });
  it("zero-count reports parse to zero and fail the gate's positive check", () => {
    const unit = parseVitestJson(fixture("vitest-zero.json"));
    const e2e = parsePlaywrightJson(fixture("playwright-zero.json"));
    expect(unit.tests).toBe(0);
    expect(e2e.tests).toBe(0);
    expect(() => requirePositive("unit", unit.tests)).toThrow(/zero tests/);
    expect(() => requirePositive("e2e", e2e.tests)).toThrow(/zero tests/);
    expect(requirePositive("unit", 7)).toBe(7);
  });
  it("rejects output that is not a report", () => {
    expect(() => parseVitestJson("{}")).toThrow(/not a vitest/);
    expect(() => parsePlaywrightJson("{}")).toThrow(/not a Playwright/);
    expect(() => parseVitestJson("PASS 12 tests")).toThrow();
  });
});

describe("dbUrlFor", () => {
  it("replaces only the database name", () => {
    expect(dbUrlFor("postgres://u:p%40ss@localhost:54329/syngmb_test?sslmode=disable", "g_1_unit")).toBe(
      "postgres://u:p%40ss@localhost:54329/g_1_unit?sslmode=disable",
    );
  });
});

describe("docs-only decision", () => {
  it("marketing content under apps/web/content is code, even as .md", () => {
    expect(docsOnlyDecision(["apps/web/content/blog/launch.md"]).docsOnly).toBe(false);
    expect(docsOnlyDecision(["apps/web/README.md"]).docsOnly).toBe(true);
  });
  it("canary: a documentation-only list skips and names every file", () => {
    const d = docsOnlyDecision(["docs/roadmap/progress.md", "README.md"]);
    expect(d.docsOnly).toBe(true);
    expect(d.reason).toBe("docs-only: 2 files (docs/roadmap/progress.md, README.md)");
  });
  it("one code file among docs forces the full run and is named", () => {
    const d = docsOnlyDecision(["docs/a.md", "apps/web/x.ts", "scripts/gate.mjs"]);
    expect(d.docsOnly).toBe(false);
    expect(d.reason).toBe("full run: 2 of 3 changed files are not docs (apps/web/x.ts, scripts/gate.mjs)");
  });
  it("zero changed files is never docs-only", () => {
    expect(docsOnlyDecision([])).toEqual({ docsOnly: false, reason: "full run: 0 changed files" });
  });
  it("a nested .md file counts as docs", () => {
    expect(docsOnlyDecision(["apps/web/README.md"]).docsOnly).toBe(true);
  });
  it("any file under docs/ counts, whatever its extension", () => {
    expect(docsOnlyDecision(["docs/x.ts"]).docsOnly).toBe(true);
  });
  it("lookalikes are not docs: .mdx, CHANGELOG, docs-like prefixes", () => {
    expect(docsOnlyDecision(["page.mdx"]).docsOnly).toBe(false);
    expect(docsOnlyDecision(["CHANGELOG"]).docsOnly).toBe(false);
    expect(docsOnlyDecision(["docs.ts"]).docsOnly).toBe(false);
    expect(docsOnlyDecision(["mydocs/x.ts"]).docsOnly).toBe(false);
  });
});

describe("findReportLine", () => {
  it("canary: reads the [seo] summary line from a Playwright JSON report's stdout", () => {
    expect(findReportLine(fixture("playwright-seo.json"), "[seo] ")).toBe("[seo] 6 URLs checked, 0 failed, 3 waived");
  });
  it("returns null when no test printed it (the spec did not run)", () => {
    expect(findReportLine(fixture("playwright-ok.json"), "[seo] ")).toBeNull();
  });
});
