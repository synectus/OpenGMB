import { describe, expect, it } from "vitest";
import { findRaw, MAP, rewrite, SCOPE, scanRepo } from "./color-classes";

describe("findRaw", () => {
  it("canary: flags a palette class", () => {
    expect(findRaw('className="px-2 text-slate-600"').map((f) => f.base)).toEqual(["text-slate-600"]);
  });

  it("flags the old brand variables", () => {
    expect(findRaw('"shadow-[inset_3px_0_0_var(--brand-primary,#0f172a)]"')).toHaveLength(1);
  });

  it("canary: template adjacency", () => {
    expect(findRaw("`text-red-700${x}`")).toHaveLength(1);
    expect(findRaw("`${x}bg-white`")).toHaveLength(1);
    expect(findRaw("\"a,bg-white\"")).toHaveLength(1);
  });

  it("canary: important modifier", () => {
    expect(findRaw('"!bg-white"')).toHaveLength(1);
    expect(findRaw('"bg-white!"')).toHaveLength(1);
    expect(findRaw('"hover:!bg-white"')).toHaveLength(1);
  });

  it("canary: bracket opacity, new prefixes and colours", () => {
    expect(findRaw('"bg-white/[.5]"')).toHaveLength(1);
    for (const c of ["via-red-500", "caret-red-500", "decoration-red-500", "ring-offset-white", "bg-purple-500", "bg-pink-500", "bg-violet-500", "bg-cyan-500", "bg-teal-500", "bg-fuchsia-500"]) {
      expect(findRaw(`"${c}"`), c).toHaveLength(1);
    }
  });

  it("flags arbitrary hex colours but not other arbitrary values", () => {
    expect(findRaw('"bg-[#fff] text-[#1a1a1a]"')).toHaveLength(2);
    expect(findRaw('"rounded-[9px] text-[17px] size-[17px]"')).toEqual([]);
  });

  it("skips comment lines", () => {
    expect(findRaw("// text-red-700 here\n * bg-white too")).toEqual([]);
    expect(rewrite("// bg-white\n * text-black\nx bg-white")).toBe("// bg-white\n * text-black\nx bg-card");
  });

  it("ignores token classes", () => {
    expect(findRaw('"bg-card text-muted-foreground border-border"')).toEqual([]);
  });
});

describe("rewrite", () => {
  it("maps classes and keeps variant prefixes", () => {
    expect(rewrite('"hover:bg-slate-50 focus-visible:outline-[var(--brand-primary,#0f172a)]"')).toBe(
      '"hover:bg-muted focus-visible:outline-ring"',
    );
  });

  it("rewrites next to templates and keeps the important modifier", () => {
    expect(rewrite("`text-red-700${x} ${y}bg-white !bg-white bg-white! hover:!text-black`")).toBe(
      "`text-bad${x} ${y}bg-card !bg-card bg-card! hover:!text-foreground`",
    );
  });

  it("leaves non-colour classes alone", () => {
    expect(rewrite('"text-sm font-semibold"')).toBe('"text-sm font-semibold"');
  });

  it("ignores Object.prototype member names", () => {
    expect(rewrite("const valueOf = constructor.toString")).toBe("const valueOf = constructor.toString");
  });

  it("never maps to a palette class", () => {
    for (const to of Object.values(MAP)) expect(findRaw(`"${to}"`)).toEqual([]);
  });
});

describe("the web app", () => {
  it("has no palette classes left (denominator printed)", () => {
    const { files, findings } = scanRepo();
    console.log(`color-classes: ${files} files scanned in ${SCOPE}, ${findings.length} raw colour classes`);
    expect(files).toBeGreaterThan(50);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.token}`)).toEqual([]);
  });
});
