import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A "use client" file must not reach a VALUE import from the root "@opengmb/core" barrel: it pulls the
// database, pg, fs and dns into the browser bundle and `next build` fails ("Can't resolve 'fs'").
// Type-only imports are erased and fine; "@opengmb/core/time", "/limits" and "/topics" are client-safe.
// Typecheck and the other unit tests cannot see this.
const root = join(__dirname, "..");

/** True when the source has a non-type import or re-export from exactly "@opengmb/core". */
export function hasCoreValueImport(src: string): boolean {
  if (/(?:^|\n)\s*import\s+["']@opengmb\/core["']/.test(src)) return true;
  for (const m of src.matchAll(/^(?:import|export)\s+([^;'"]*?)\s+from\s+["']@opengmb\/core["']/gm)) {
    const clause = m[1]!.trim();
    if (/^type\s/.test(clause)) continue;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) return true; // default, namespace or export *
    if (clause.replace(braces[0], "").replace(/[,\s]/g, "") !== "") return true; // default + braces
    if (braces[1]!.split(",").some((x) => x.trim() !== "" && !/^type\s/.test(x.trim()))) return true;
  }
  return false;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next" || n === "_generated") return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const resolveImport = (from: string, spec: string) => {
  const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  return [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts"), base].find(
    (c) => /\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile(),
  );
};
const isClient = (src: string) => /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test(src);

describe("client components and the server barrel", () => {
  it("canary: the detector flags value imports and ignores type-only ones", () => {
    expect(hasCoreValueImport('import { REVIEW_TOPIC_IDS } from "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('import { a, type B } from "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('import core from "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('import * as core from "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('export * from "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('import "@opengmb/core";')).toBe(true);
    expect(hasCoreValueImport('import type { A } from "@opengmb/core";')).toBe(false);
    expect(hasCoreValueImport('import { type A, type B } from "@opengmb/core";')).toBe(false);
    expect(hasCoreValueImport('import { dayKey } from "@opengmb/core/time";')).toBe(false);
    expect(hasCoreValueImport('import { REVIEW_TOPIC_IDS } from "@opengmb/core/topics";')).toBe(false);
    expect(isClient('"use client";\nimport x from "y";')).toBe(true);
    expect(isClient('import x from "y";\n"use client";')).toBe(false);
  });

  it("no file a client component can reach imports a value from @opengmb/core", () => {
    const entries = [...files(join(root, "app")), ...files(join(root, "components"))].filter((f) => isClient(readFileSync(f, "utf8")));
    const bad = new Map<string, string>();
    const seen = new Set<string>();
    for (const entry of entries) {
      const visit = (f: string, via: string) => {
        if (seen.has(f)) return;
        seen.add(f);
        const src = readFileSync(f, "utf8");
        // A server action file or a server-only module is a boundary: a client component only gets its stub.
        if (/^\s*["']use server["']/.test(src) || /import\s+["']server-only["']/.test(src)) return;
        if (hasCoreValueImport(src)) bad.set(relative(root, f), relative(root, via));
        for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
          const r = resolveImport(f, m[1]!);
          if (r && !/\.test\./.test(r) && !r.includes("_generated")) visit(r, entry);
        }
      };
      visit(entry, entry);
    }
    console.log(`${entries.length} client files checked, ${seen.size} files reached`);
    expect(entries.length).toBeGreaterThan(50);
    expect([...bad].map(([f, via]) => `${f} (reached from ${via})`)).toEqual([]);
  });
});
