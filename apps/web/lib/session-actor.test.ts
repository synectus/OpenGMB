import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// AP4: while a platform admin views a customer, EVERY web caller must act as that customer's read-only owner view.
// A second loadActor call site would fall back to the admin's own organization (wrong, and writable). So apps/web
// has exactly one non-test call site: sessionActor in lib/auth.ts. e2e/ holds seed scripts that run before any
// session exists, and is not part of the app.
const root = join(__dirname, "..");
const CALL = /\bloadActor\s*\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (["node_modules", ".next", "e2e"].includes(n)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe("one actor-loading path", () => {
  it("canary: the detector matches a call", () => {
    expect('const a = await loadActor(db, { userId });'.match(CALL)).toHaveLength(1);
    expect("loadActorX(1)".match(CALL)).toBeNull();
  });

  it("apps/web calls loadActor from exactly one place, lib/auth.ts", () => {
    const all = files(root);
    const hits = all.flatMap((f) => {
      const n = (readFileSync(f, "utf8").match(CALL) ?? []).length;
      return n ? [{ file: f.slice(root.length + 1), n }] : [];
    });
    const total = hits.reduce((a, h) => a + h.n, 0);
    console.log(`[view-as] loadActor call sites in apps/web: ${total} (${hits.map((h) => h.file).join(", ")}); ${all.length} files scanned`);
    expect(all.length).toBeGreaterThan(100);
    expect(hits).toEqual([{ file: "lib/auth.ts", n: 1 }]);
  });
});
