import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The only files that may call `.updateReply(` / `.deleteReply(`: the guarded module and the client implementations. */
const ALLOWED = new Set([
  "packages/core/src/reviews/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);

const CALL = /\.(updateReply|deleteReply)\s*\(/g;

/** Drops block comments and whole-line `//` comments, so prose that mentions a call is not a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

export function findReplyWrites(src: string): string[] {
  return [...stripComments(src).matchAll(CALL)].map((m) => m[1]!);
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);
const isSource = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.(ts|tsx)$/.test(f);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (isSource(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

describe("Google reply writes are reachable only through the guarded publish module", () => {
  it("canary: the matcher finds a call, ignores comments and declarations", () => {
    expect(findReplyWrites("await client.updateReply(x)")).toEqual(["updateReply"]);
    expect(findReplyWrites("client\n  .deleteReply (name)")).toEqual(["deleteReply"]);
    expect(findReplyWrites("// client.updateReply(x)\n/* a.deleteReply(y) */")).toEqual([]);
    expect(findReplyWrites("async updateReply(name: string) {}")).toEqual([]);
  });

  it("no source file outside the allowed list calls updateReply or deleteReply", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const allowedSites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findReplyWrites(readFileSync(f, "utf8")).length;
      if (hits === 0) continue;
      if (ALLOWED.has(rel)) allowedSites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    const sites = Object.values(allowedSites).reduce((n, h) => n + h, 0);
    console.log(`scanned ${files.length} files, ${sites} allowed call sites`);
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    // The allowed files really do contain the calls (a broken walk or matcher would show 0 here).
    expect(allowedSites["packages/core/src/reviews/publish.ts"]).toBeGreaterThanOrEqual(2);
    expect(allowedSites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(2);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/** Post writes: only the guarded posts module and the client implementations may call these. */
const POST_ALLOWED = new Set([
  "packages/core/src/posts/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);
const POST_CALL = /\.(createLocalPost|updateLocalPost|deleteLocalPost)\s*\(/g;

export function findPostWrites(src: string): string[] {
  return [...stripComments(src).matchAll(POST_CALL)].map((m) => m[1]!);
}

describe("Google local post writes are reachable only through posts/publish.ts", () => {
  it("canary: the matcher finds a call, ignores comments and declarations", () => {
    expect(findPostWrites("await client.createLocalPost(p, x)")).toEqual(["createLocalPost"]);
    expect(findPostWrites("c\n  .updateLocalPost (n, p, m)")).toEqual(["updateLocalPost"]);
    expect(findPostWrites("x.deleteLocalPost(n)")).toEqual(["deleteLocalPost"]);
    expect(findPostWrites("// c.createLocalPost(x)\n/* a.deleteLocalPost(y) */")).toEqual([]);
    expect(findPostWrites("async createLocalPost(parent: string) {}")).toEqual([]);
    expect(findPostWrites("client.listLocalPosts(parent)")).toEqual([]);
  });

  it("no source file outside the allowed list calls the post write methods", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const sites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findPostWrites(readFileSync(f, "utf8")).length;
      if (hits === 0) continue;
      if (POST_ALLOWED.has(rel)) sites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    console.log(
      `post writes: scanned ${files.length} files, ${Object.keys(sites).length} allowed files`,
    );
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    expect(sites["packages/core/src/posts/publish.ts"]).toBeGreaterThanOrEqual(3);
    expect(sites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(3);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/** Profile writes: only the guarded profile module and the client implementations may call these. */
const PROFILE_ALLOWED = new Set([
  "packages/core/src/profile/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);
const PROFILE_CALL = /\.(updateLocation|updateAttributes)\s*\(/g;

export function findProfileWrites(src: string): string[] {
  return [...stripComments(src).matchAll(PROFILE_CALL)].map((m) => m[1]!);
}

describe("Google profile writes are reachable only through profile/publish.ts", () => {
  it("canary: the matcher finds a call, ignores comments and declarations", () => {
    expect(findProfileWrites("await client.updateLocation(n, p, m)")).toEqual(["updateLocation"]);
    expect(findProfileWrites("g\n  .updateAttributes (n, a, m)")).toEqual(["updateAttributes"]);
    expect(findProfileWrites("// c.updateLocation(x)\n/* a.updateAttributes(y) */")).toEqual([]);
    expect(findProfileWrites("async updateLocation(name: string) {}")).toEqual([]);
    expect(findProfileWrites("client.getLocation(n); client.getAttributes(n)")).toEqual([]);
  });

  it("no source file outside the allowed list calls updateLocation or updateAttributes", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const sites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findProfileWrites(readFileSync(f, "utf8")).length;
      if (hits === 0) continue;
      if (PROFILE_ALLOWED.has(rel)) sites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    console.log(
      `profile writes: scanned ${files.length} files, ${Object.keys(sites).length} allowed files`,
    );
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    expect(sites["packages/core/src/profile/publish.ts"]).toBeGreaterThanOrEqual(2);
    expect(sites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(2);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/** Photo writes: only the guarded media module and the client implementations may call these. */
const MEDIA_ALLOWED = new Set([
  "packages/core/src/media/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);
const MEDIA_CALL =
  /\.(createMedia|deleteMedia|startMediaUpload|uploadMediaBytes|uploadMedia)\s*\(/g;

export function findMediaWrites(src: string): string[] {
  return [...stripComments(src).matchAll(MEDIA_CALL)].map((m) => m[1]!);
}

describe("Google media writes are reachable only through media/publish.ts", () => {
  it("canary: the matcher finds a call, ignores comments, declarations and reads", () => {
    expect(findMediaWrites("await client.createMedia(p, x, c)")).toEqual(["createMedia"]);
    expect(findMediaWrites("c\n  .deleteMedia (n, ctx)")).toEqual(["deleteMedia"]);
    expect(findMediaWrites("await g.startMediaUpload(parent)")).toEqual(["startMediaUpload"]);
    expect(findMediaWrites("await g.uploadMediaBytes(ref, b, t)")).toEqual(["uploadMediaBytes"]);
    expect(findMediaWrites("client\n .uploadMedia(p, i, f, c)")).toEqual(["uploadMedia"]);
    expect(findMediaWrites("// g.startMediaUpload(p)\nasync uploadMediaBytes(r: R) {}")).toEqual(
      [],
    );
    expect(findMediaWrites("// c.createMedia(x)\n/* a.deleteMedia(y) */")).toEqual([]);
    expect(findMediaWrites("async createMedia(parent: string) {}")).toEqual([]);
    expect(findMediaWrites("client.listMedia(p); client.listCustomerMedia(p)")).toEqual([]);
  });

  it("no source file outside the allowed list calls a Google media write (create, delete, startUpload, upload bytes)", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const sites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findMediaWrites(readFileSync(f, "utf8")).length;
      if (hits === 0) continue;
      if (MEDIA_ALLOWED.has(rel)) sites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    console.log(
      `media writes: scanned ${files.length} files, ${Object.keys(sites).length} allowed files`,
    );
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    expect(sites["packages/core/src/media/publish.ts"]).toBeGreaterThanOrEqual(3);
    expect(sites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(5);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/** Place action link writes: only the guarded module and the client implementations. */
const PLACE_ALLOWED = new Set([
  "packages/core/src/placeActions/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);
const PLACE_CALL = /\.(createPlaceActionLink|updatePlaceActionLink|deletePlaceActionLink)\s*\(/g;

export function findPlaceActionWrites(src: string): string[] {
  return [...stripComments(src).matchAll(PLACE_CALL)].map((m) => m[1]!);
}

describe("Google place action link writes are reachable only through placeActions/publish.ts", () => {
  it("canary: the matcher finds a call, ignores comments, declarations and reads", () => {
    expect(findPlaceActionWrites("await c.createPlaceActionLink(p, l, x)")).toEqual([
      "createPlaceActionLink",
    ]);
    expect(findPlaceActionWrites("c\n  .updatePlaceActionLink (n, p, m, x)")).toEqual([
      "updatePlaceActionLink",
    ]);
    expect(findPlaceActionWrites("x.deletePlaceActionLink(n, ctx)")).toEqual([
      "deletePlaceActionLink",
    ]);
    expect(
      findPlaceActionWrites("// c.createPlaceActionLink(x)\n/* a.deletePlaceActionLink(y) */"),
    ).toEqual([]);
    expect(findPlaceActionWrites("async createPlaceActionLink(parent: string) {}")).toEqual([]);
    expect(findPlaceActionWrites("client.listPlaceActionLinks(parent)")).toEqual([]);
  });

  it("no source file outside the allowed list calls the place action write methods", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const sites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findPlaceActionWrites(readFileSync(f, "utf8")).length;
      if (hits === 0) continue;
      if (PLACE_ALLOWED.has(rel)) sites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    console.log(
      `place action writes: scanned ${files.length} files, ${Object.keys(sites).length} allowed files`,
    );
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    expect(sites["packages/core/src/placeActions/publish.ts"]).toBeGreaterThanOrEqual(3);
    expect(sites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(3);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/** Food menu writes: only the guarded module and the client implementations. */
const FOOD_ALLOWED = new Set([
  "packages/core/src/foodMenus/publish.ts",
  "packages/core/src/google/throttled-client.ts",
  "packages/core/src/google/mock-client.ts",
  "packages/core/src/google/live-client.ts",
]);
const FOOD_CALL = /\.updateFoodMenus\s*\(/g;

export function findFoodMenuWrites(src: string): number {
  return [...stripComments(src).matchAll(FOOD_CALL)].length;
}

describe("Google food menu writes are reachable only through foodMenus/publish.ts", () => {
  it("canary: the matcher finds a call, ignores comments, declarations and reads", () => {
    expect(findFoodMenuWrites("await c.updateFoodMenus(m, ['menus'], x)")).toBe(1);
    expect(findFoodMenuWrites("c\n  .updateFoodMenus (m)")).toBe(1);
    expect(findFoodMenuWrites("// c.updateFoodMenus(x)")).toBe(0);
    expect(findFoodMenuWrites("async updateFoodMenus(m: M) {}")).toBe(0);
    expect(findFoodMenuWrites("client.getFoodMenus(name)")).toBe(0);
  });

  it("no source file outside the allowed list calls updateFoodMenus", () => {
    const files = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    const sites: Record<string, number> = {};
    for (const f of files) {
      const rel = relative(ROOT, f);
      const hits = findFoodMenuWrites(readFileSync(f, "utf8"));
      if (hits === 0) continue;
      if (FOOD_ALLOWED.has(rel)) sites[rel] = hits;
      else offenders.push(`${rel} (${hits})`);
    }
    console.log(
      `food menu writes: scanned ${files.length} files, ${Object.keys(sites).length} allowed files`,
    );
    expect(files.length, "scanner found no files").toBeGreaterThan(50);
    expect(sites["packages/core/src/foodMenus/publish.ts"]).toBeGreaterThanOrEqual(1);
    expect(sites["packages/core/src/google/throttled-client.ts"]).toBeGreaterThanOrEqual(1);
    expect(offenders, `callers outside the guarded module:\n${offenders.join("\n")}`).toEqual([]);
  });
});
