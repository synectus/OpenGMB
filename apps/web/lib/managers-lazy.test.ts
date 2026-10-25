import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/(app)/locations/[id]/profile/page.tsx");
const panel = read("components/profile/google-managers.tsx");
const CALL = /locationManagers_list|locationManagersList/g;
const calls = (src: string) => [...src.matchAll(CALL)].length;

describe("Google managers are read on demand, never by the profile page render", () => {
  it("canary: the matcher finds a call, and the page really is the profile page", () => {
    expect(calls("await locationManagers_list({ locationId })")).toBe(1);
    expect(page).toContain("placeActions_list({ locationId: id })");
  });

  it("the profile page server render makes no managers call", () => {
    expect(calls(page)).toBe(0);
    expect(page).toContain("<GoogleManagers locationId={id} />");
  });

  it("the panel fetches only inside the Load handler and has no effect hook", () => {
    const uses = [...panel.matchAll(/locationManagers_list\(/g)].map((m) => panel.slice(m.index - 8, m.index));
    expect(uses.length).toBe(1);
    expect(uses[0]).toContain("=> ");
    expect(panel).not.toMatch(/useEffect/);
  });
});
