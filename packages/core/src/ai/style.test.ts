import { describe, expect, it } from "vitest";
import {
  AVOID_IN_PROMPT_ONLY,
  BANNED_ADJECTIVES,
  BANNED_BUZZWORDS,
  BANNED_CLAUDE_TELLS,
  BANNED_COPULA,
  BANNED_FILLER,
  BANNED_OPENERS,
  BANNED_PHRASES,
  BANNED_STARTS,
  BANNED_TRANSITIONS,
  BANNED_VERBS,
  MARKET_VOICE,
  marketForTimeZone,
  SCANNED_PHRASES,
} from "../config/writing-style";
import { runGuardrails, type GuardrailContext } from "../guardrails";
import { buildSystemPrompt, EMPTY_VOICE } from "./voice";
import { cleanEmDashes, styleLines } from "./style";

const ctx = (reply: string): GuardrailContext => ({
  reply,
  review: { rating: 5, text: "Lovely visit.", reviewerDisplayName: null },
  location: { name: "Riverside Clinic", phone: null },
  workspace: { profile: "general", packs: [], skipPositiveReviews: false, staffNames: [] },
  recentReplies: [],
});
const style = (reply: string) => runGuardrails(ctx(reply)).violations.filter((v) => v.ruleId === "U8.style");

describe("writing style config", () => {
  it("prints its denominator and no list is empty", () => {
    const lists = {
      transitions: BANNED_TRANSITIONS, openers: BANNED_OPENERS, adjectives: BANNED_ADJECTIVES,
      verbs: BANNED_VERBS, buzzwords: BANNED_BUZZWORDS, copula: BANNED_COPULA,
      claudeTells: BANNED_CLAUDE_TELLS, phrases: BANNED_PHRASES, filler: BANNED_FILLER,
      starts: BANNED_STARTS, promptOnly: AVOID_IN_PROMPT_ONLY,
    };
    console.log(
      Object.entries(lists).map(([k, v]) => `${k}=${v.length}`).join(" "),
      `scanned=${SCANNED_PHRASES.length}`,
    );
    for (const [name, list] of Object.entries(lists)) expect(list.length, name).toBeGreaterThan(0);
    expect(SCANNED_PHRASES.length).toBeGreaterThan(100);
  });

  it("picks the market from the workspace time zone, default US", () => {
    expect(marketForTimeZone("Asia/Kolkata")).toBe("in");
    expect(marketForTimeZone("Australia/Melbourne")).toBe("au");
    expect(marketForTimeZone("America/Chicago")).toBe("us");
    expect(marketForTimeZone("UTC")).toBe("us");
    expect(marketForTimeZone(null)).toBe("us");
  });

  it("puts the market's spelling in the prompt, and every banned list", () => {
    expect(styleLines("au").join("\n")).toContain("colour");
    expect(styleLines("us").join("\n")).toContain("color");
    expect(Object.keys(MARKET_VOICE)).toEqual(["us", "au", "in"]);
    const all = styleLines("us").join("\n");
    for (const w of ["furthermore", "seamless", "delve", "game-changer", "serves as", "overall"]) {
      expect(all).toContain(w);
    }
  });

  it("the brand voice comes after the style and is stated to win", () => {
    const p = buildSystemPrompt("reply", { ...EMPTY_VOICE, tone: "blunt", signOff: "Cheers, Sam" }, { market: "us" });
    expect(p.indexOf("Writing style")).toBeLessThan(p.indexOf("Tone: blunt"));
    expect(p).toContain("brand voice below overrides the writing style");
  });
});

describe("cleanEmDashes", () => {
  it("replaces a dash with a comma and removes edge dashes", () => {
    expect(cleanEmDashes("Sorry about that — we will fix it.")).toBe("Sorry about that, we will fix it.");
    expect(cleanEmDashes("Thanks—truly.")).toBe("Thanks, truly.");
    expect(cleanEmDashes("— Thanks")).toBe("Thanks");
    expect(cleanEmDashes("Thanks —")).toBe("Thanks");
    expect(cleanEmDashes("Sorry. — Please call.")).toBe("Sorry. Please call.");
    expect(cleanEmDashes("No dash here.")).toBe("No dash here.");
  });
  it("leaves no em dash behind, however many", () => {
    expect(cleanEmDashes("a — b — c—d")).not.toContain("—");
  });
});

describe("U8.style guardrail rule", () => {
  it("canary: fires, as a warning, on known banned wording", () => {
    for (const text of [
      "We aim for a seamless visit every time.",
      "We are leveraging your feedback.",
      "Furthermore, the team read it.",
      "Thanks for the note — we read it.",
      "Certainly, we are sorry the wait ran long.",
      "Our cutting edge approach helps.",
      "It delves into the cause.",
    ]) {
      const v = style(text);
      expect(v, text).toHaveLength(1);
      expect(v[0]!.severity).toBe("warn");
      expect(v[0]!.matches!.length).toBeGreaterThan(0);
    }
  });
  it("canary: stays quiet on plain wording, near-misses and a mid-text 'of course'", () => {
    for (const text of [
      "Thanks for the review. We are glad the visit went well.",
      "The front-desk team read every word. See you next time.",
      "Thanks for writing. Of course the team wants to hear more, so please call us.",
      "Our levers and pulleys are fine, and the team is on it.",
      "We will pass this on.",
    ]) {
      expect(style(text), text).toHaveLength(0);
    }
  });
  it("a warning does not block", () => {
    expect(runGuardrails(ctx("A seamless visit, thanks for writing.")).ok).toBe(true);
  });
});
