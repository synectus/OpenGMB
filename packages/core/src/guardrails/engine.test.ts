import { describe, expect, it } from "vitest";
import { GuardrailBlockedError, assertPassed, runGuardrails } from "./engine";
import { PACK_RULES, allRules } from "./packs";
import { compileLexicon, findMatches, firstSentence, normalise } from "./text";
import type { GuardrailContext, PackId } from "./types";

function ctx(reply: string, over: Partial<GuardrailContext> = {}, packs: PackId[] = []) {
  const base: GuardrailContext = {
    reply,
    review: { rating: 5, text: null, reviewerDisplayName: null },
    location: { name: "Riverside Family Clinic", phone: "(713) 555-0142" },
    workspace: { profile: "general", packs, skipPositiveReviews: false, staffNames: [] },
    recentReplies: [],
  };
  return { ...base, ...over };
}

describe("runGuardrails: pack selection", () => {
  it("always runs universal, even with no packs enabled", () => {
    const r = runGuardrails(ctx("See riverside.example.com"));
    expect(r.packs).toEqual(["universal"]);
    expect(r.violations.map((v) => v.ruleId)).toEqual(["U7.url"]);
    expect(r.ok).toBe(false);
  });

  it("does not run hipaa unless enabled", () => {
    const reply = "Thanks for visiting us!";
    expect(runGuardrails(ctx(reply)).violations).toEqual([]);
    const on = runGuardrails(ctx(reply, {}, ["hipaa"]));
    expect(on.packs).toEqual(["universal", "hipaa"]);
    expect(on.violations.map((v) => v.ruleId)).toEqual(["H1"]);
  });

  it("does not run legal_ethics unless enabled", () => {
    const reply = "Your case was important to us.";
    expect(runGuardrails(ctx(reply, {}, ["hipaa"])).violations).toEqual([]);
    expect(runGuardrails(ctx(reply, {}, ["legal_ethics"])).violations.map((v) => v.ruleId)).toEqual(
      ["LE1.relationship"],
    );
  });

  it("listing universal explicitly does not run it twice", () => {
    const r = runGuardrails(ctx("See riverside.example.com", {}, ["universal", "universal"]));
    expect(r.packs).toEqual(["universal"]);
    expect(r.violations).toHaveLength(1);
  });

  it("is deterministic and does not mutate its input", () => {
    const c = ctx("Thanks for visiting. Dr. Pratt #blessed", {}, ["hipaa", "legal_ethics"]);
    const before = JSON.stringify(c);
    const a = runGuardrails(c);
    const b = runGuardrails(c);
    expect(a).toEqual(b);
    expect(JSON.stringify(c)).toBe(before);
  });

  it("ok means no block: warnings alone pass", () => {
    const r = runGuardrails(ctx("Thrilled to hear from you."));
    expect(r.violations.map((v) => [v.ruleId, v.severity])).toEqual([["U4", "warn"]]);
    expect(r.ok).toBe(true);
  });
});

describe("runGuardrails: severityOverrides", () => {
  const withOverrides = (
    reply: string,
    severityOverrides: Record<string, "block" | "warn">,
    over: Partial<GuardrailContext> = {},
  ) => {
    const base = ctx(reply, over, ["hipaa"]);
    return { ...base, workspace: { ...base.workspace, severityOverrides } };
  };
  const reviewer = { rating: 5 as const, text: null, reviewerDisplayName: "Maria Lopez" };

  it("default (no override) keeps H2 as a block", () => {
    const r = runGuardrails(ctx("Maria, we are sorry.", { review: reviewer }, ["hipaa"]));
    expect(r.violations.find((v) => v.ruleId === "H2.reviewer")?.severity).toBe("block");
    expect(r.ok).toBe(false);
  });

  it("H2.* downgrades every H2 rule to warn, keeping message and offsets; ok becomes true", () => {
    const base = runGuardrails(ctx("Maria, we are sorry.", { review: reviewer }, ["hipaa"]));
    const r = runGuardrails(
      withOverrides("Maria, we are sorry.", { "H2.*": "warn" }, { review: reviewer }),
    );
    const b = base.violations.find((v) => v.ruleId === "H2.reviewer")!;
    const w = r.violations.find((v) => v.ruleId === "H2.reviewer")!;
    expect(w.severity).toBe("warn");
    expect(w.message).toBe(b.message);
    expect(w.matches).toEqual(b.matches);
    expect(r.ok).toBe(true);
    expect(() => assertPassed(r, "Maria, we are sorry.")).not.toThrow();
  });

  it("does not touch other rules: a non-H2 block stays a block (H1 and U7)", () => {
    const r = runGuardrails(
      withOverrides(
        "Maria, thanks for visiting us at https://example.com",
        { "H2.*": "warn" },
        { review: reviewer },
      ),
    );
    const sev = Object.fromEntries(r.violations.map((v) => [v.ruleId, v.severity]));
    expect(sev["H2.reviewer"]).toBe("warn");
    expect(sev["H1"]).toBe("block");
    expect(sev["U7.url"]).toBe("block");
    expect(r.ok).toBe(false);
  });

  it("the pattern is a prefix: H2.* does not match H20 or H2 itself; an exact key beats the pattern", () => {
    const miss = runGuardrails(
      withOverrides("Maria, we are sorry.", { "H20.*": "warn", H2: "warn" }, { review: reviewer }),
    );
    expect(miss.violations.find((v) => v.ruleId === "H2.reviewer")?.severity).toBe("block");
    const exact = runGuardrails(
      withOverrides(
        "Maria, we are sorry.",
        { "H2.*": "warn", "H2.reviewer": "block" },
        { review: reviewer },
      ),
    );
    expect(exact.violations.find((v) => v.ruleId === "H2.reviewer")?.severity).toBe("block");
  });

  it("an override can also raise a warning to a block", () => {
    const r = runGuardrails(withOverrides("Thrilled to hear from you.", { U4: "block" }));
    expect(r.ok).toBe(false);
  });

  it("does not mutate the context overrides", () => {
    const o: Record<string, "block" | "warn"> = { "H2.*": "warn" };
    runGuardrails(withOverrides("Maria, we are sorry.", o, { review: reviewer }));
    expect(o).toEqual({ "H2.*": "warn" });
  });
});

describe("runGuardrails: rule status", () => {
  it("propagates pending_counsel_review to violations and still runs the rule", () => {
    const r = runGuardrails(ctx("Your case was important.", {}, ["legal_ethics"]));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({
      ruleId: "LE1.relationship",
      packId: "legal_ethics",
      status: "pending_counsel_review",
      severity: "block",
    });
    expect(r.ok).toBe(false);
  });

  it("marks active rules active", () => {
    const r = runGuardrails(ctx("See riverside.example.com"));
    expect(r.violations[0]?.status).toBe("active");
  });

  it("every legal_ethics rule is pending_counsel_review; no other pack's rule is", () => {
    for (const rule of allRules()) {
      expect(rule.status).toBe(
        rule.packId === "legal_ethics" ? "pending_counsel_review" : "active",
      );
    }
  });

  it("rule ids are unique and each rule's packId matches the pack it is registered in", () => {
    const rules = allRules();
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const [pack, packRules] of Object.entries(PACK_RULES)) {
      for (const rule of packRules) expect(rule.packId).toBe(pack);
    }
  });
});

describe("assertPassed", () => {
  it("returns the branded value for an ok result", () => {
    const reply = "Thanks for writing in.";
    const result = runGuardrails(ctx(reply));
    const passed = assertPassed(result, reply);
    expect(passed.reply).toBe(reply);
    expect(passed.result).toBe(result);
  });

  it("accepts a result that only has warnings", () => {
    const reply = "Thrilled to hear from you.";
    expect(assertPassed(runGuardrails(ctx(reply)), reply).result.violations).toHaveLength(1);
  });

  it("throws GuardrailBlockedError on a block, naming the rule", () => {
    const reply = "See riverside.example.com";
    const result = runGuardrails(ctx(reply));
    expect(() => assertPassed(result, reply)).toThrow(GuardrailBlockedError);
    expect(() => assertPassed(result, reply)).toThrow(/U7\.url/);
  });

  it("throws if the reply differs from the checked text", () => {
    const result = runGuardrails(ctx("Thanks for writing in."));
    expect(() => assertPassed(result, "Something else entirely.")).toThrow(/differs/);
  });

  it("throws for a hand-built result the engine never issued", () => {
    const forged = { ok: true, violations: [], packs: ["universal" as const] };
    expect(() => assertPassed(forged, "anything")).toThrow(/not produced by runGuardrails/);
  });

  it("throws for a copy of an issued result", () => {
    const reply = "Thanks for writing in.";
    const copy = { ...runGuardrails(ctx(reply)) };
    expect(() => assertPassed(copy, reply)).toThrow(/not produced by runGuardrails/);
  });
});

describe("violation offsets index the original text", () => {
  it("with smart quotes and extra whitespace before the match", () => {
    const reply =
      "We’re  grateful — “thanks” for writing.\n\nPlease see www.riverside.example.com now.";
    const v = runGuardrails(ctx(reply)).violations.find((x) => x.ruleId === "U7.url");
    expect(v?.matches).toHaveLength(1);
    const m = v!.matches![0]!;
    expect(reply.slice(m.start, m.end)).toBe(m.text);
    expect(m.text).toBe("www.riverside.example.com");
  });

  it("for a phrase containing a smart apostrophe", () => {
    const reply = "Honestly, we’re glad you’re feeling better today.";
    const r = runGuardrails(ctx(reply, {}, ["hipaa"]));
    const m = r.violations.find((x) => x.ruleId === "H1")!.matches![0]!;
    expect(reply.slice(m.start, m.end)).toBe(m.text);
    expect(m.text).toBe("glad you’re feeling better");
  });

  it("is stable when the location name is masked before matching", () => {
    const reply = "Harbor Spine Clinic says thanks for visiting.";
    const r = runGuardrails(
      ctx(reply, { location: { name: "Harbor Spine Clinic", phone: null } }, ["hipaa"]),
    );
    expect(r.violations.map((v) => v.ruleId)).toEqual(["H1"]);
    const m = r.violations[0]!.matches![0]!;
    expect(reply.slice(m.start, m.end)).toBe("thanks for visiting");
  });

  it("all reported matches slice back to their own text", () => {
    const reply =
      "Hi Maria’s family, Dr. Pratt says: your back pain on Monday and 3/14/2026 — call us!";
    const r = runGuardrails(
      ctx(
        reply,
        {
          review: {
            rating: 5,
            text: "My back pain on Monday",
            reviewerDisplayName: "Maria Gonzalez",
          },
        },
        ["hipaa"],
      ),
    );
    let checked = 0;
    for (const v of r.violations)
      for (const m of v.matches ?? []) {
        expect(reply.slice(m.start, m.end)).toBe(m.text);
        checked++;
      }
    expect(checked).toBeGreaterThan(3);
  });
});

describe("text helpers", () => {
  it("normalise folds case, quotes, whitespace and punctuation", () => {
    expect(normalise("  We CAN’T  wait!!\n")).toBe(normalise("we can't wait"));
    expect(normalise("We can’t wait")).toBe("we cant wait");
  });

  it("firstSentence stops at terminal punctuation or a line break", () => {
    expect(firstSentence("Hello there! Second one.")).toBe("Hello there");
    expect(firstSentence("No terminal punctuation")).toBe("No terminal punctuation");
    expect(firstSentence("Line one\nLine two.")).toBe("Line one");
  });

  it("lexicon matching is whole-word and separator-flexible", () => {
    const re = compileLexicon(["x(-| )?rays?", "that's not true"]);
    expect(findMatches("Our X-Ray room, x ray, xrays", re).map((m) => m.text)).toEqual([
      "X-Ray",
      "x ray",
      "xrays",
    ]);
    expect(findMatches("That’s   not true. Thats not true.", re)).toHaveLength(2);
    expect(findMatches("sex-rayon", re)).toHaveLength(0);
  });

  it("compileLexicon rejects an empty lexicon rather than matching nothing silently", () => {
    expect(() => compileLexicon([])).toThrow();
  });
});
