import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";

const app = join(__dirname, "..", "app");
const src = (p: string) => readFileSync(join(app, p), "utf8");

describe("password reset pages", () => {
  it("the forgot-password page decides 'email is not set up' at request time, not at build", () => {
    const page = src("forgot-password/page.tsx");
    expect(page).toMatch(/await connection\(\)/);
    expect(page.indexOf("await connection()")).toBeLessThan(page.indexOf("emailConfigured()"));
  });
  it("the reset-password page is dynamic (it reads searchParams) and is public", () => {
    expect(src("reset-password/page.tsx")).toMatch(/await searchParams/);
    expect(isPublicPath("/reset-password")).toBe(true);
    expect(isPublicPath("/forgot-password")).toBe(true);
  });
  it("both routes send the client messages their forms use", () => {
    for (const d of ["forgot-password", "reset-password"]) {
      expect(src(`${d}/layout.tsx`), d).toContain('set="resetFlow"');
    }
  });
});
