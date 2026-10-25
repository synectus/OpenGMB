import { describe, expect, it } from "vitest";
import hipaaCorpus from "./corpus/hipaa.json";
import { CORPUS_FILES as FILES, corpusContext as buildContext, type Entry } from "./corpus/load";
import { runGuardrails } from "./engine";
import { allRules } from "./packs";

const all = Object.entries(FILES).flatMap(([file, f]) => f.entries.map((e) => ({ file, f, e })));

describe("guardrail corpus", () => {
  it("is not empty and ids are unique", () => {
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map((x) => x.e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(all.map((x) => [`${x.file}/${x.e.id}`, x] as const))("%s", (_name, { f, e }) => {
    const result = runGuardrails(buildContext(f, e));
    expect([...new Set(result.violations.map((v) => v.ruleId))].sort()).toEqual(
      [...e.expect.ruleIds].sort(),
    );
    expect(result.ok).toBe(e.expect.ok);
    // ok must agree with the severities of what fired.
    expect(result.ok).toBe(!result.violations.some((v) => v.severity === "block"));
  });

  it("every registered rule has at least one failing fixture", () => {
    const covered = new Set(all.flatMap((x) => x.e.expect.ruleIds));
    const rules = allRules();
    const missing = rules.filter((r) => !covered.has(r.id)).map((r) => r.id);
    const unknown = [...covered].filter((id) => !rules.some((r) => r.id === id));

    let matched = 0;
    for (const { f, e } of all) {
      const fired = new Set(runGuardrails(buildContext(f, e)).violations.map((v) => v.ruleId));
      matched += e.expect.ruleIds.filter((id) => fired.has(id)).length;
    }
    console.log(
      `${all.length} replies, ${matched} expected violations matched, ${rules.length - missing.length}/${rules.length} rules covered`,
    );

    expect(rules.length).toBeGreaterThan(0);
    expect(missing, `rules with zero failing fixtures: ${missing.join(", ")}`).toEqual([]);
    expect(unknown, `fixtures expect unregistered rule ids: ${unknown.join(", ")}`).toEqual([]);
  });

  it("each corpus file has clean pass fixtures", () => {
    // Canary against a corpus that only ever fails: every pack file needs passing entries.
    for (const [name, f] of Object.entries(FILES)) {
      const passes = f.entries.filter((e) => e.expect.ok && e.expect.ruleIds.length === 0);
      expect(passes.length, `${name} corpus has no clean pass fixtures`).toBeGreaterThan(0);
    }
  });
});

describe("guardrail corpus: HIPAA H2 warn mode (workspace severity override H2.*)", () => {
  const h2 = (id: string) => id.startsWith("H2.");
  const hipaaEntries = hipaaCorpus.entries as unknown as Entry[];

  it("every H2.* violation in the corpus turns into a warning; everything else is unchanged", () => {
    let h2Seen = 0;
    let okFlipped = 0;
    for (const e of hipaaEntries) {
      const file = FILES.hipaa!;
      const base = runGuardrails(buildContext(file, e));
      const warn = runGuardrails(buildContext(file, e, { "H2.*": "warn" }));
      expect(warn.violations.map((v) => [v.ruleId, v.message, v.matches])).toEqual(
        base.violations.map((v) => [v.ruleId, v.message, v.matches]),
      );
      for (const [i, v] of warn.violations.entries()) {
        const b = base.violations[i]!;
        if (h2(v.ruleId)) {
          h2Seen++;
          expect(v.severity, `${e.id} ${v.ruleId}`).toBe("warn");
        } else {
          expect(v.severity, `${e.id} ${v.ruleId}`).toBe(b.severity);
        }
      }
      expect(warn.ok, e.id).toBe(
        !base.violations.some((v) => !h2(v.ruleId) && v.severity === "block"),
      );
      if (warn.ok && !base.ok) okFlipped++;
    }
    console.log(`H2 warn mode: ${h2Seen} H2 violations downgraded, ${okFlipped} replies now ok`);
    expect(h2Seen).toBeGreaterThan(10);
    expect(okFlipped).toBeGreaterThan(5);
  });

  it("covers every H2.* rule with a fixture that becomes ok=true when it is the only violation", () => {
    const ids = allRules()
      .map((r) => r.id)
      .filter(h2);
    expect(ids.sort()).toEqual(
      ["H2.clinical", "H2.date", "H2.echo", "H2.provider", "H2.reviewer", "H2.staff"].sort(),
    );
    for (const id of ids) {
      const only = hipaaEntries.find(
        (e) => e.expect.ruleIds.length === 1 && e.expect.ruleIds[0] === id,
      );
      // H2.echo only ever fires together with H2.clinical in this corpus.
      const entry =
        only ??
        hipaaEntries.find(
          (e) =>
            e.expect.ruleIds.length > 0 &&
            e.expect.ruleIds.every(h2) &&
            e.expect.ruleIds.includes(id),
        );
      expect(entry, `no H2-only fixture for ${id}`).toBeDefined();
      const r = runGuardrails(buildContext(FILES.hipaa!, entry!, { "H2.*": "warn" }));
      expect(r.ok, id).toBe(true);
      expect(r.violations.find((v) => v.ruleId === id)?.severity, id).toBe("warn");
    }
  });
});
