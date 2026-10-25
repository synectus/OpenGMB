// apps/web/lib/no-raw-ids.test.ts
// Static guard (U2): no component prints a Google id, a guardrail rule code or a raw enum through
// a JSX expression that skips lib/labels.ts. The e2e guard checks rendered pages; this one catches
// the usual shapes in source, cheaply.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));
// `{v.ruleId}` and `{x.status.replaceAll("_", " ")}` printed straight into JSX; `font-mono` ids.
const BAD = [/>\s*\{[a-z]\w*\.ruleId\}\s*</, /\{[\w.]+\.replaceAll\("_", " "\)\}/, /shortId\([^)]*\)\}<\/span>/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" || f === "e2e" || f === "_generated" ? [] : files(p);
    return /\.tsx$/.test(f) ? [p] : [];
  });
}

const findings = (rel: string, source: string) =>
  source.split("\n").flatMap((line, i) => (BAD.some((re) => re.test(line)) ? [`${rel}:${i + 1}: ${line.trim()}`] : []));

describe("no raw ids in JSX", () => {
  it("canary: the matcher flags the known-bad lines", () => {
    expect(findings("x.tsx", "<strong>{v.ruleId}</strong>")).toHaveLength(1);
    expect(findings("x.tsx", '<b>{status.replaceAll("_", " ")}</b>')).toHaveLength(1);
    expect(findings("x.tsx", "<span>{shortId(o.name)}</span>")).toHaveLength(1);
    expect(findings("x.tsx", "<b>{guardrailLabel(v.ruleId, v.message)}</b>")).toEqual([]);
  });

  it("no component prints them", () => {
    // components/site/ is the marketing site: it shows guardrail rule ids on purpose, as documented codes.
    const all = files(WEB).filter((f) => !path.relative(WEB, f).startsWith("components/site/"));
    console.log(`no-raw-ids: ${all.length} component files scanned`);
    expect(all.length).toBeGreaterThan(100); // fail on zero: the walk must find the app
    const bad = all.flatMap((f) => findings(path.relative(WEB, f), readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
