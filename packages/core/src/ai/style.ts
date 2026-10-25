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
  EM_DASH,
  MARKET_VOICE,
  TONE_RULES,
  type MarketCode,
} from "../config/writing-style";

/**
 * Replace every em dash with a comma, or nothing when it sits at an edge or next to punctuation. Done in
 * code after the model answers, because asking the model not to is not enough (the style config says never).
 */
export function cleanEmDashes(text: string): string {
  return text.replace(new RegExp(`\\s*${EM_DASH}\\s*`, "g"), (m, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + m.length);
    if (before.trim() === "" || after.trim() === "") return "";
    if (/^[.,;:!?]/.test(after)) return "";
    if (/[.,;:!?]$/.test(before)) return " ";
    return ", ";
  });
}

/** The style section of a system prompt, from the config lists. */
export function styleLines(market: MarketCode): string[] {
  const m = MARKET_VOICE[market];
  const banned = [
    ...BANNED_TRANSITIONS,
    ...BANNED_OPENERS,
    ...BANNED_ADJECTIVES,
    ...BANNED_VERBS,
    ...BANNED_BUZZWORDS,
    ...BANNED_COPULA,
    ...BANNED_CLAUDE_TELLS,
    ...BANNED_PHRASES,
    ...BANNED_FILLER,
    ...AVOID_IN_PROMPT_ONLY,
  ];
  return [
    `Writing style. Never use the em dash character (${EM_DASH}); use a comma or a full stop.`,
    ...TONE_RULES,
    `Never start with: ${BANNED_STARTS.join(", ")}.`,
    `Never use these words or phrases: ${banned.join(", ")}.`,
    `Market: ${m.label}. ${m.spelling} ${m.voice}`,
  ];
}
