import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";
import { buildCsp } from "./security-headers";
import { isPublicPath } from "./public-paths";

const PUBLIC_DIR = path.resolve(__dirname, "../public");
const sw = readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8");

describe("root layout metadata", () => {
  it("names the app OpenGMB in the page title and the Apple home-screen title (read from the source: layout.tsx loads next/font)", () => {
    const src = readFileSync(path.resolve(__dirname, "../app/layout.tsx"), "utf8");
    expect(src).toContain('title: "OpenGMB",');
    expect(src).toContain('appleWebApp: { capable: true, title: "OpenGMB" }');
    expect(src).not.toContain("SynGMB");
  });
});

describe("web app manifest", () => {
  const m = manifest();
  it("is installable: name, start URL, standalone display, 192 and 512 PNG icons", () => {
    expect(m.name).toBe("OpenGMB");
    expect(m.short_name).toBe("OpenGMB");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    const icons = m.icons ?? [];
    for (const size of ["192x192", "512x512"]) {
      expect(icons.some((i) => i.sizes === size && i.type === "image/png"), size).toBe(true);
    }
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
  it("every icon it names exists on disk and is a PNG", () => {
    const icons = m.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    for (const i of icons) {
      const file = path.join(PUBLIC_DIR, i.src);
      expect(existsSync(file), i.src).toBe(true);
      expect(readFileSync(file).subarray(1, 4).toString(), i.src).toBe("PNG");
    }
  });
});

describe("service worker", () => {
  it("canary: handles push and notification clicks", () => {
    expect(sw).toMatch(/addEventListener\(\s*["']push["']/);
    expect(sw).toMatch(/addEventListener\(\s*["']notificationclick["']/);
  });
  it("keeps no client data: no fetch handler and no Cache API", () => {
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/\bcaches\b/);
    expect(sw).not.toMatch(/\bindexedDB\b|\blocalStorage\b/);
  });
  it("only opens same-origin paths from a payload", () => {
    expect(sw).toMatch(/startsWith\(["']\/["']\)/);
    expect(sw).toMatch(/startsWith\(["']\/\/["']\)/);
  });
});

describe("served without a session, under the CSP", () => {
  it("the manifest, worker and icons are public paths", () => {
    for (const p of ["/manifest.webmanifest", "/sw.js", "/icons/icon-192.png", "/icons/apple-touch-icon.png"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ["/sw.js/x", "/icons", "/icons/x/y.png", "/manifest.webmanifest.bak"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
  it("the policy already allows a same-origin worker and manifest, and blocks other origins", () => {
    const csp = buildCsp("n", false).split("; ");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("default-src 'self'");
    expect(csp.some((d) => d.startsWith("manifest-src"))).toBe(false); // falls back to default-src 'self'
  });
});
