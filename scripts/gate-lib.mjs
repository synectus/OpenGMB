// Pure helpers for scripts/gate.mjs. Counts come from JSON reports parsed with JSON.parse, never
// from text matching, and a count of zero is an error: silence is never a pass.
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Vitest `--reporter=json` output -> { tests, files, failed }. */
export function parseVitestJson(text) {
  const r = JSON.parse(text);
  if (typeof r.numTotalTests !== "number" || !Array.isArray(r.testResults)) {
    throw new Error("not a vitest JSON report (numTotalTests/testResults missing)");
  }
  return { tests: r.numTotalTests, files: r.testResults.length, failed: r.numFailedTests ?? 0 };
}

/** Playwright `--reporter=json` output -> { tests, failed, skipped }. A flaky test counts as failed. */
export function parsePlaywrightJson(text) {
  const r = JSON.parse(text);
  if (!Array.isArray(r.suites)) throw new Error("not a Playwright JSON report (suites missing)");
  let tests = 0;
  let failed = 0;
  let skipped = 0;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        tests += 1;
        if (t.status === "skipped") skipped += 1;
        else if (t.status !== "expected") failed += 1;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of r.suites) walk(s);
  return { tests, failed, skipped };
}

/**
 * The first stdout line starting with `prefix` that a test printed, read from a Playwright `--reporter=json` report; null when no test
 * printed one. For "[seo] " only the summary ("[seo] N URLs checked ...") counts, not the "[seo] FAIL ..." detail lines.
 */
export function findReportLine(text, prefix) {
  const r = JSON.parse(text);
  if (!Array.isArray(r.suites)) throw new Error("not a Playwright JSON report (suites missing)");
  const wanted = prefix === "[seo] " ? /^\[seo\] \d+ URLs checked/ : null;
  let found = null;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const res of t.results ?? []) {
          for (const out of res.stdout ?? []) {
            for (const line of String(out.text ?? "").split("\n")) {
              if (found === null && line.startsWith(prefix) && (wanted ? wanted.test(line) : true)) found = line;
            }
          }
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of r.suites) walk(s);
  return found;
}

/** Throws unless n is a positive integer: a check that ran nothing must not pass. */
export function requirePositive(label, n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label}: counted ${n} tests; a gate that ran zero tests has checked nothing`);
  }
  return n;
}

/** The same connection URL with only the database name replaced. */
export function dbUrlFor(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** .env in dir, else in the main worktree (worktrees have no .env of their own). */
export function findEnvFile(dir) {
  const here = path.join(dir, ".env");
  if (existsSync(here)) return here;
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const main = path.join(path.dirname(common), ".env");
  return existsSync(main) ? main : null;
}

/**
 * Changed file paths -> { docsOnly, reason }. Docs-only means at least one file and every file is
 * under docs/ or ends in .md, except .md files under apps/web/content/ (marketing page content is code: the SEO check must run on it). An empty list is never docs-only: a skip that inspected nothing must
 * not look like a pass. The reason names every file for a skip, and the non-docs files otherwise.
 */
export function docsOnlyDecision(files) {
  if (files.length === 0) return { docsOnly: false, reason: "full run: 0 changed files" };
  const code = files.filter((f) => !(f.startsWith("docs/") || (f.endsWith(".md") && !f.startsWith("apps/web/content/"))));
  if (code.length === 0) {
    return { docsOnly: true, reason: `docs-only: ${files.length} files (${files.join(", ")})` };
  }
  return {
    docsOnly: false,
    reason: `full run: ${code.length} of ${files.length} changed files are not docs (${code.join(", ")})`,
  };
}
