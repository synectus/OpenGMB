// apps/web/lib/scope-usage.test.ts
// Static guard: app pages get their scope from currentScope(), never by parsing ?ws= themselves,
// and render no per-page Workspace picker. Pages still waiting for plan 0C2 are allowlisted, and
// each allowlisted page must still have a hit (so the list cannot go stale).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL("../app/(app)", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));

const RULES: { name: string; re: RegExp }[] = [
  { name: "reads ?ws= outside currentScope", re: /\bsp\.ws\b|\{\s*ws\s*\}\s*=\s*await searchParams/ },
  { name: "workspace or scope <select>", re: /<select[^>]*name="(ws|scope)"/ },
  { name: "Workspace pills or select label", re: /(aria-)?label="Workspace"/ },
];

/** Empty since plan 0C2: every app page reads currentScope(). */
const PENDING_0C2 = new Set<string>([]);

function hits(source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, i) =>
      line.includes("currentScope(") ? [] : RULES.filter((r) => r.re.test(line)).map((r) => `${i + 1}: ${r.name}`),
    );
}

/**
 * U5: what every app page does under "All clients". A new page fails the guard until it is listed here.
 * - works: reads the scope and shows real content across clients (narrowed by a client, group or location).
 * - picker: needs one client and shows an inline "Pick a client to ..." picker (ChooseClient). `files` (from apps/web) are the
 *   extra sources that hold a picker for one of the page's views.
 * - org-wide: not filtered by the scope at all (the whole organization, or one record named by the URL).
 * e2e/smoke.spec.ts renders each of these routes under All clients with a second client and checks the same.
 */
type Mode = "works" | "picker" | "org-wide";
const MANIFEST: Record<string, { mode: Mode; files?: string[] }> = {
  "page.tsx": { mode: "works" },
  "approvals/page.tsx": { mode: "works" },
  "locations/page.tsx": { mode: "works" },
  "locations/alerts/page.tsx": { mode: "works" },
  "locations/health/page.tsx": { mode: "works" },
  "reviews/page.tsx": { mode: "picker", files: ["components/reviews/bulk-reply-view.tsx"] },
  "posts/page.tsx": { mode: "picker" },
  "performance/page.tsx": { mode: "picker" },
  "reports/new/page.tsx": { mode: "works" },
  "locations/bulk-edit/page.tsx": { mode: "picker" },
  "locations/import/page.tsx": { mode: "picker" },
  "settings/workspace/page.tsx": { mode: "picker" },
  "settings/templates/page.tsx": { mode: "picker" },
  "settings/privacy/page.tsx": { mode: "picker" },
  "reports/page.tsx": { mode: "org-wide" },
  "reports/[id]/edit/page.tsx": { mode: "org-wide" },
  "agents/page.tsx": { mode: "org-wide" },
  "audit/page.tsx": { mode: "org-wide" },
  "geogrid/page.tsx": { mode: "org-wide" },
  "account/page.tsx": { mode: "org-wide" },
  "workspaces/page.tsx": { mode: "org-wide" },
  "settings/page.tsx": { mode: "org-wide" },
  "settings/branding/page.tsx": { mode: "org-wide" },
  "settings/google/page.tsx": { mode: "org-wide" },
  "settings/notifications/page.tsx": { mode: "org-wide" },
  "settings/status/page.tsx": { mode: "org-wide" },
  "settings/team/page.tsx": { mode: "org-wide" },
  "settings/organizations/page.tsx": { mode: "org-wide" },
  "settings/health/page.tsx": { mode: "org-wide" },
  "settings/integrations/page.tsx": { mode: "org-wide" },
  "settings/tokens/page.tsx": { mode: "org-wide" },
  "settings/webhooks/page.tsx": { mode: "org-wide" },
  "settings/billing/page.tsx": { mode: "org-wide" },
  "locations/[id]/page.tsx": { mode: "org-wide" },
  "locations/[id]/profile/page.tsx": { mode: "org-wide" },
  "locations/[id]/media/page.tsx": { mode: "org-wide" },
  "locations/[id]/health/page.tsx": { mode: "org-wide" },
  "locations/[id]/changes/page.tsx": { mode: "org-wide" },
  "locations/[id]/citations/page.tsx": { mode: "org-wide" },
  "locations/[id]/suspension/page.tsx": { mode: "org-wide" },
};

/** The inline picker: a ChooseClient whose title says what the client is needed for. */
const PICKER = /<ChooseClient[^>]*\b(?:title="Pick a client to [^"]+"|title=\{t\w*\("[\w.]+"\)\})/s;
/** Pages that read the scope must call currentScope(); org-wide pages must not render a picker. */
function problems(rel: string, source: string, extra: string[]): string[] {
  const entry = MANIFEST[rel];
  if (!entry) return [`${rel}: not in MANIFEST (classify it as works, picker or org-wide)`];
  const out: string[] = [];
  const all = [source, ...extra].join("\n");
  if (entry.mode !== "org-wide" && !source.includes("currentScope(")) out.push(`${rel}: ${entry.mode} page never calls currentScope()`);
  if (entry.mode === "picker" && !PICKER.test(all)) out.push(`${rel}: picker page has no ChooseClient titled "Pick a client to ..."`);
  if (entry.mode === "org-wide" && all.includes("<ChooseClient")) out.push(`${rel}: org-wide page renders a picker, classify it as picker`);
  if (all.includes("No client selected")) out.push(`${rel}: says "No client selected" instead of "Pick a client to ..."`);
  return out;
}

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : f === "page.tsx" ? [p] : [];
  });
}

describe("scope usage", () => {
  it("canary: each rule matches its known-bad line, and currentScope lines pass", () => {
    expect(hits("  const ws = isUuid(sp.ws) ? sp.ws : undefined;")).toHaveLength(1);
    expect(hits("  const { ws } = await searchParams;")).toHaveLength(1);
    expect(hits('            <select name="ws" defaultValue={x}>')).toHaveLength(1);
    expect(hits('            <select name="scope" defaultValue={x}>')).toHaveLength(1);
    expect(hits('        <PillLinks label="Workspace" items={[]} />')).toHaveLength(1);
    expect(hits("  const scope = await currentScope(sp.ws);")).toEqual([]);
    expect(hits('  <input type="hidden" name="ws" value={scope.urlWs} />')).toEqual([]);
  });

  it("no converted page reads ?ws= itself or renders a Workspace picker", () => {
    const all = pages(APP);
    console.log(`scope-usage: ${all.length} pages scanned, ${PENDING_0C2.size} pending 0C2`);
    expect(all.length).toBeGreaterThan(25); // fail on zero: the walk must find the app
    const bad: string[] = [];
    for (const file of all) {
      const rel = path.relative(APP, file).split(path.sep).join("/");
      const found = hits(readFileSync(file, "utf8"));
      if (PENDING_0C2.has(rel)) {
        if (found.length === 0) bad.push(`${rel}: allowlisted but clean, remove it from PENDING_0C2`);
      } else bad.push(...found.map((h) => `${rel}:${h}`));
    }
    expect(bad).toEqual([]);
  });

  it("canary: the picker pattern matches a real picker and rejects the old copy", () => {
    expect(PICKER.test('<ChooseClient\n  title="Pick a client to work on its posts"\n  text="x"')).toBe(true);
    expect(PICKER.test('<ChooseClient title="No client selected" text="x"')).toBe(false);
    expect(problems("nope/page.tsx", "", [])).toHaveLength(1);
    expect(problems("posts/page.tsx", "currentScope(", [])).toHaveLength(1); // a picker page without a picker
  });

  it("every app page is classified; scoped pages read the scope; picker pages carry an inline picker", () => {
    const all = pages(APP);
    const rels = all.map((f) => path.relative(APP, f).split(path.sep).join("/"));
    const bad: string[] = [];
    for (const [i, file] of all.entries()) {
      const rel = rels[i]!;
      const extra = (MANIFEST[rel]?.files ?? []).map((f) => readFileSync(path.join(WEB, f), "utf8"));
      bad.push(...problems(rel, readFileSync(file, "utf8"), extra));
    }
    for (const rel of Object.keys(MANIFEST)) if (!rels.includes(rel)) bad.push(`${rel}: in MANIFEST but no such page`);
    const count = (m: Mode) => Object.values(MANIFEST).filter((e) => e.mode === m).length;
    console.log(
      `all-clients: ${all.length} pages scanned, ${count("works")} work across clients, ${count("picker")} have an inline picker, ${count("org-wide")} are org-wide`,
    );
    expect(all.length).toBeGreaterThan(25); // fail on zero
    expect(count("works") + count("picker")).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});
