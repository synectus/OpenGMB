import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_STATES } from "./empty-states";

const web = path.resolve(__dirname, "..");
// The pages the roadmap (U10) names. A page missing from the registry fails here.
const REQUIRED = ["reviews", "posts", "approvals", "locations", "performance", "reports", "alerts", "changes", "rank-tracking", "audit", "photos"];

describe("empty states say what to do next", () => {
  it("is route-driven: every listed page has copy, a link, and renders it from the registry", () => {
    const entries = Object.values(EMPTY_STATES);
    // Fail on zero, and on a page dropped from the registry.
    expect(entries.length, "registry must not be empty").toBeGreaterThan(0);
    expect(Object.keys(EMPTY_STATES).sort()).toEqual([...REQUIRED].sort());

    const problems: string[] = [];
    for (const [id, e] of Object.entries(EMPTY_STATES)) {
      const page = path.join(web, "app/(app)", e.route, "page.tsx");
      if (!existsSync(page)) problems.push(`${id}: no page at ${e.route}`);
      const src = existsSync(path.join(web, e.file)) ? readFileSync(path.join(web, e.file), "utf8") : "";
      if (!new RegExp(`<EmptyNext\\s+id="${id}"`).test(src)) problems.push(`${id}: ${e.file} does not render <EmptyNext id="${id}">`);
      if (e.title.trim().length < 3 || /^no data\.?$/i.test(e.title.trim())) problems.push(`${id}: weak title "${e.title}"`);
      if (e.next.trim().length < 20) problems.push(`${id}: next-step text is too short`);
      if (e.cta.label.trim().length < 3) problems.push(`${id}: link has no label`);
      const anchor = e.cta.href.startsWith("#") && src.includes(`id="${e.cta.href.slice(1)}"`);
      if (!(e.cta.href.startsWith("/") || anchor) || /undefined|null/.test(e.cta.href)) problems.push(`${id}: bad link ${e.cta.href}`);
    }
    console.log(`empty states checked: ${entries.length} pages (${Object.keys(EMPTY_STATES).join(", ")})`);
    expect(problems).toEqual([]);
  });

  it("canary: the page check does catch a page that does not use the registry", () => {
    const src = readFileSync(path.join(web, "app/(app)/page.tsx"), "utf8");
    expect(/<EmptyNext\s+id="reviews"/.test(src)).toBe(false);
    expect(/<EmptyNext\s+id="reviews"/.test('<EmptyNext id="reviews" />')).toBe(true);
  });
});
