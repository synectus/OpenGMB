import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const comp = (f: string) => readFileSync(join(__dirname, "../components/rank-tracking", f), "utf8");

describe("the 'Not live' chip is shown only while rank data is sample", () => {
  it("canary: the detector sees the chip in the shared component", () => {
    expect(comp("badges.tsx")).toMatch(/export function NotLiveNote/);
  });
  for (const f of ["tracker-setup-form.tsx", "preview-and-run.tsx"]) {
    it(`${f} gates every NotLiveNote on sample`, () => {
      const uses = comp(f).match(/.*<NotLiveNote>.*/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/\bsample\b\s*&&/);
    });
  }
});
