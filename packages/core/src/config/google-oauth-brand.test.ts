import { describe, expect, it } from "vitest";
import { GOOGLE_OAUTH_BRAND } from "./google-oauth-brand";

type Fact = { value?: unknown; sourceUrl?: string; verifiedOn?: string; status?: string };

/** Empty means every fact names an https source and an ISO date that is not in the future. */
export function factProblems(facts: Record<string, Fact>, today = new Date().toISOString().slice(0, 10)): string[] {
  const out: string[] = [];
  for (const [k, f] of Object.entries(facts)) {
    if (f.value === undefined || f.value === "") out.push(`${k}: value missing`);
    if (!f.sourceUrl?.startsWith("https://")) out.push(`${k}: sourceUrl missing`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.verifiedOn ?? "")) out.push(`${k}: verifiedOn missing`);
    else if (f.verifiedOn! > today) out.push(`${k}: verifiedOn in the future`);
    if (f.status !== "verified" && f.status !== "unverified") out.push(`${k}: status missing`);
  }
  return out;
}

describe("Google OAuth brand facts", () => {
  it("canary: the checker catches a fact without a date or a source", () => {
    expect(factProblems({ x: { value: "A", sourceUrl: "https://a", status: "verified" } })).toEqual(["x: verifiedOn missing"]);
    expect(factProblems({ y: { value: "B", verifiedOn: "2026-01-01", status: "verified" } })).toEqual(["y: sourceUrl missing"]);
  });

  it("every fact has a source and a date (prints the denominator)", () => {
    const n = Object.keys(GOOGLE_OAUTH_BRAND).length;
    console.log(`${n} facts checked in google-oauth-brand.ts`);
    expect(n).toBeGreaterThan(0);
    expect(factProblems(GOOGLE_OAUTH_BRAND)).toEqual([]);
  });

  it("the app name is the default unless GOOGLE_OAUTH_BRAND_APP_NAME is set", () => {
    expect(GOOGLE_OAUTH_BRAND.appName.value).toBe(process.env.GOOGLE_OAUTH_BRAND_APP_NAME?.trim() || "OpenGMB");
  });
});
