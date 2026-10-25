// apps/web/lib/no-utc-copy.test.ts
// Static guard (F4): no page tells people "Times are UTC". Times follow the client's time zone, so
// copy that says otherwise is a bug. Server-schedule and CSV column labels are allowlisted below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const BAD = /Times are UTC|All times UTC|times in UTC|Dates are UTC|\((?:UTC|UTC, [a-z]+)\)|UTC everywhere/;

/** file suffix -> the exact text allowed to match (server cron column, CSV column header). */
const ALLOWED: Record<string, string[]> = {
    "lib/review-filters.ts": ["Date (UTC)"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" || f === "e2e" || f === "_generated" ? [] : files(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

function findings(rel: string, source: string): string[] {
  const allowed = ALLOWED[rel] ?? [];
  return source.split("\n").flatMap((line, i) => {
    const m = BAD.exec(line);
    return m && !allowed.some((a) => line.includes(a)) ? [`${rel}:${i + 1}: ${m[0]}`] : [];
  });
}

describe("no UTC copy", () => {
  it("canary: the matcher flags the known-bad strings", () => {
    expect(findings("x.tsx", 'description="Write a post. Times are UTC."')).toHaveLength(1);
    expect(findings("x.tsx", "<th>When (UTC)</th>")).toHaveLength(1);
    expect(findings("x.tsx", "<span>All times UTC</span>")).toHaveLength(1);
    expect(findings("x.tsx", "<th>Local time</th>")).toEqual([]);
  });

  it("no page or component says times are UTC", () => {
    const all = files(WEB);
    console.log(`no-utc-copy: ${all.length} source files scanned`);
    expect(all.length).toBeGreaterThan(200); // fail on zero: the walk must find the app
    const bad = all.flatMap((f) => findings(path.relative(WEB, f), readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("each allowlisted line still exists (the list cannot go stale)", () => {
    for (const [rel, texts] of Object.entries(ALLOWED)) {
      const src = readFileSync(path.join(WEB, rel), "utf8");
      for (const t of texts) expect(src, `${rel} no longer has "${t}"`).toContain(t);
    }
  });
});
