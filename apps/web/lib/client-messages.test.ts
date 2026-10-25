import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { roleHasPermission } from "@opengmb/core";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../messages";
import { CLIENT_NAMESPACES, MESSAGE_SETS, pickMessages } from "../messages/client";

const root = join(__dirname, "..");

// Namespaces that are deliberately in no message set. The one entry is rendered only inside
// StaffMessages (components/rank-tracking/staff-messages.tsx), which the geogrid page mounts for
// roles with geogrid:cost; a client viewer never receives it.
const STAFF_ONLY = ["geogridCost", "aiCost"];
const MONEY = [/markup/i, /budget/i, /\bCharged\b/];

function flat(o: unknown, p = ""): [string, string][] {
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === "string" ? [[p ? `${p}.${k}` : k, v] as [string, string]] : flat(v, p ? `${p}.${k}` : k),
  );
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe("client message namespaces", () => {
  const used = new Map<string, string[]>();
  const bare: string[] = [];
  let scanned = 0;
  for (const dir of ["app", "components", "lib"]) {
    for (const f of files(join(root, dir))) {
      scanned++;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\buseTranslations\(\s*(?:["'`]([\w.]+)["'`])?\s*\)/g)) {
        if (!m[1]) bare.push(f);
        else used.set(m[1].split(".")[0]!, [...(used.get(m[1].split(".")[0]!) ?? []), f]);
      }
    }
  }

  it("scans real files and finds the known namespaces (canary)", () => {
    console.log(`${scanned} files scanned, ${used.size} namespaces used by useTranslations`);
    expect(scanned).toBeGreaterThan(100);
    expect(used.has("shell")).toBe(true);
  });

  // Route proof. For every route file (page, layout, loading, error, not-found) the namespaces its
  // import graph can call useTranslations with must be in the set it renders under: the innermost
  // <ClientMessages set="..."> in a layout from app/ down to the file's folder (or in the page
  // itself). An inner provider replaces the outer messages, so only that one set counts.
  const appDir = join(root, "app");
  const SET_TAG = /<ClientMessages\s+set="(\w+)"/;
  const resolveImport = (from: string, spec: string) => {
    const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    return [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts"), base].find(
      (c) => /\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile(),
    );
  };
  const nsOf = (f: string) =>
    [...readFileSync(f, "utf8").matchAll(/\buseTranslations\(\s*["'`]([\w.]+)["'`]\s*\)/g)].map((m) => m[1]!.split(".")[0]!);
  function needs(entry: string): Set<string> {
    const seen = new Set<string>();
    const out = new Set<string>();
    const visit = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const n of nsOf(f)) out.add(n);
      for (const m of readFileSync(f, "utf8").matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const r = resolveImport(f, m[1]!);
        if (r && !/\.test\./.test(r)) visit(r);
      }
    };
    visit(entry);
    return out;
  }
  const ROUTE_FILE = /^(page|layout|loading|error|not-found)\.tsx$/;
  const routeFiles = files(appDir).filter((f) => ROUTE_FILE.test(f.split("/").pop()!));
  const setOf = (f: string): string | undefined => {
    const own = f.endsWith("/page.tsx") ? SET_TAG.exec(readFileSync(f, "utf8"))?.[1] : undefined;
    if (own) return own;
    let found: string | undefined;
    const parts = relative(appDir, dirname(f)).split("/").filter(Boolean);
    for (let i = 0; i <= parts.length; i++) {
      const layout = join(appDir, ...parts.slice(0, i), "layout.tsx");
      if (existsSync(layout)) found = SET_TAG.exec(readFileSync(layout, "utf8"))?.[1] ?? found;
    }
    return found;
  };

  it("every route file renders under a message set that holds every namespace its imports use", () => {
    const wrong: string[] = [];
    let withNs = 0;
    for (const f of routeFiles) {
      const set = setOf(f);
      const want = [...needs(f)].filter((n) => !STAFF_ONLY.includes(n));
      if (want.length) withNs++;
      const have: readonly string[] = set ? MESSAGE_SETS[set as keyof typeof MESSAGE_SETS] : [];
      const lacking = want.filter((n) => !have.includes(n));
      if (!set || lacking.length) wrong.push(`${relative(root, f)}: set "${set}" lacks ${lacking.join(", ")}`);
    }
    console.log(`${routeFiles.length} route files checked, ${withNs} use client namespaces`);
    expect(routeFiles.length).toBeGreaterThan(60);
    expect(withNs).toBeGreaterThan(30);
    expect(wrong).toEqual([]);
  });

  it("canary: the route check does catch a namespace missing from a set", () => {
    const page = routeFiles.find((f) => f.endsWith("(app)/reviews/page.tsx"))!;
    expect(needs(page).has("reviewsTools")).toBe(true);
    expect(MESSAGE_SETS.audit as readonly string[]).not.toContain("reviewsTools");
  });

  it("every <ClientMessages set> names a real set, and every set is used", () => {
    const tags = [...routeFiles, ...files(join(root, "components"))].flatMap((f) => {
      const m = SET_TAG.exec(readFileSync(f, "utf8"));
      return m ? [m[1]!] : [];
    });
    expect(tags.filter((t) => !(t in MESSAGE_SETS))).toEqual([]);
    // StaffMessages reads the geogrid set directly rather than through the tag.
    expect(Object.keys(MESSAGE_SETS).filter((k) => !tags.includes(k) && k !== "geogrid")).toEqual([]);
  });

  it("the public root sends nothing, and no set holds a staff-only namespace", () => {
    expect(MESSAGE_SETS.root).toEqual([]);
    for (const [name, ns] of Object.entries(MESSAGE_SETS))
      for (const k of STAFF_ONLY) expect(ns as readonly string[], `${name} has ${k}`).not.toContain(k);
  });

  it("prints the English JSON bytes each set sends (the before was all namespaces on every page)", () => {
    const bytes = (names: readonly string[]) => JSON.stringify(pickMessages(MESSAGES.en, names)).length;
    const before = bytes(["account", "agents", "approvals", "audit", "auth", "authFlows", "common", "geogrid", "home", "liveStatus", "locationHub", "locations", "nav", "notifications", "performance", "portal", "posts", "profile", "reports", "reviews", "reviewsTools", "scope", "search", "settings", "settingsStatus", "settingsTeam", "shell", "twoFactor", "workspaces"]);
    const rows = Object.entries(MESSAGE_SETS).map(([k, v]) => `${k}=${bytes(v)}`);
    console.log(`before (every page): ${before} bytes; after per set: ${rows.join(" ")}`);
    for (const v of Object.values(MESSAGE_SETS)) expect(bytes(v)).toBeLessThan(before);
  });

  it("no useTranslations() without a namespace (it would need every message in the browser)", () => {
    expect(bare).toEqual([]);
  });

  it("every namespace in a set exists in all three languages; a missing one throws", () => {
    for (const l of ["en", "hi", "es"] as const)
      for (const k of CLIENT_NAMESPACES) expect(k in MESSAGES[l], `${l}.${k}`).toBe(true);
    expect(() => pickMessages(MESSAGES.en, ["nope"])).toThrow(/unknown namespace "nope"/);
    for (const k of STAFF_ONLY) expect(k in MESSAGES.en, k).toBe(true);
  });

  it("every role that can manage rank tracking can see cost (StaffMessages is mounted on geogrid:cost)", () => {
    const roles = ["owner", "admin", "manager", "client_approver", "client_viewer"] as const;
    const manage = roles.filter((r) => roleHasPermission(r, "geogrid:manage"));
    expect(manage.length).toBeGreaterThan(0);
    for (const r of manage) expect(roleHasPermission(r, "geogrid:cost"), r).toBe(true);
    expect(roleHasPermission("client_viewer", "geogrid:cost")).toBe(false);
  });

  describe("agency money text never reaches a client viewer's page", () => {
    it("canary: the full English messages do contain it", () => {
      const all = flat(MESSAGES.en).filter(([, v]) => MONEY.some((re) => re.test(v)));
      console.log(`${all.length} English strings mention markup, budget or Charged in total`);
      expect(all.some(([, v]) => v === "Markup (%)")).toBe(true);
      expect(flat(MESSAGES.en).length).toBeGreaterThan(1000);
    });

    for (const l of ["en", "hi", "es"] as const) {
      it(`${l}: no client message matches markup, budget or Charged, or a translated money string`, () => {
        const sent = flat(pickMessages(MESSAGES[l], CLIENT_NAMESPACES));
        const moved = flat(MESSAGES[l].geogridCost).map(([, v]) => v);
        expect(moved.length).toBeGreaterThan(0);
        // Matching the moved strings catches a Hindi or Spanish client key that repeats one verbatim.
        // Key names count too: the page's HTML carries them ("budget":{"save":...} failed the e2e check).
        const bad = sent
          .filter(([k, v]) => MONEY.some((re) => re.test(v) || re.test(k)) || moved.includes(v))
          .map(([k]) => k);
        console.log(`${l}: ${sent.length} client strings checked against ${moved.length} staff-only strings`);
        expect(bad).toEqual([]);
      });
    }
  });
});
