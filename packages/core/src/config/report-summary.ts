/**
 * Limits for the AI summary at the top of a report (A7). Model id and token prices are NOT here: they
 * come from config/ai-models.ts (AI_DEFAULTS.model, AI_MODELS). All values below are our own product
 * choices, not external facts.
 */
export const REPORT_SUMMARY = {
  /** Output ceiling for the one call (tokens). Five plain sentences are about 150 tokens. */
  maxOutputTokens: 400,
  /** A longer answer is thrown away: it is not the short summary that was asked for. */
  maxChars: 900,
  /** The prompt size the price shown before enabling assumes (characters, system plus data). */
  typicalPromptChars: 3_000,
  /** The most locations listed in the data of a review report; the rest are left out of the prompt. */
  maxLocationsInPrompt: 15,
  /** The most keywords listed in the data of a performance report. */
  maxKeywordsInPrompt: 5,
} as const;
