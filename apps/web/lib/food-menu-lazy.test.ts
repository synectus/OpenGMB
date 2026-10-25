import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/(app)/locations/[id]/profile/page.tsx");
const editor = read("components/food-menu-editor.tsx");
const CALL = /foodMenus_get|foodMenusGet/g;
const calls = (src: string) => [...src.matchAll(CALL)].length;

describe("food menu is loaded on demand, never by the profile page render", () => {
  it("canary: the matcher finds a call, and the page really is the profile page", () => {
    expect(calls("await foodMenus_get({ locationId })")).toBe(1);
    expect(page).toContain("placeActions_list({ locationId: id })");
  });

  it("the profile page server render makes no foodMenus.get call", () => {
    expect(calls(page)).toBe(0);
    expect(page).toContain("<FoodMenuEditor locationId={id} canEdit={canEdit} />");
  });

  it("the editor starts collapsed and fetches only inside handlers (Load food menu, then after a save)", () => {
    expect(editor).toContain("Load food menu");
    expect(editor).toContain('useState<"closed"');
    const uses = [...editor.matchAll(/foodMenus_get\(/g)].map((m) => editor.slice(m.index - 8, m.index));
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const before of uses) expect(before).toContain("=> ");
    // No effect hook: nothing can fetch on mount.
    expect(editor).not.toMatch(/useEffect/);
  });
});
