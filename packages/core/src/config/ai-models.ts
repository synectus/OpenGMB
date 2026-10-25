/**
 * AI model ids and prices. Not ours to choose: each carries its source and the date it was checked.
 * Prices are integer micro-USD per million tokens (1 USD = 1_000_000 micro-USD), so cost maths never
 * touches floating point. Logic reads this file; it never holds a literal price.
 */
export const AI_MODELS = {
  "claude-haiku-5-5": {
    label: "Claude Haiku 5.5",
    /** Prompts up to `tierTokens` use `base`; a longer prompt is charged at `long` for the whole call. */
    tierTokens: 100_000,
    base: { inputPerMTokMicroUsd: 100_000, outputPerMTokMicroUsd: 500_000 },
    long: { inputPerMTokMicroUsd: 500_000, outputPerMTokMicroUsd: 2_500_000 },
  },
  "claude-sonnet-5-5": {
    label: "Claude Sonnet 5.5",
    tierTokens: Number.POSITIVE_INFINITY,
    base: { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000 },
    long: { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000 },
  },
} as const;

export type AiModelId = keyof typeof AI_MODELS;

export const AI_PRICING_SOURCE = {
  sourceUrl: "https://claude.com/pricing",
  verifiedOn: "2026-10-21",
} as const;

/** Our own product choices. */
export const AI_DEFAULTS = {
  model: "claude-haiku-5-5" as AiModelId,
  /** Platform-wide monthly cap in USD when AI_MONTHLY_BUDGET_USD is unset. Our choice. */
  platformMonthlyBudgetUsd: 10,
  /** Largest source text one call accepts (characters). Keeps every call far below the long-prompt price tier. */
  maxSourceChars: 20_000,
  /**
   * Most reviews one bulk AI draft run takes. Our choice: the calls run one after another (a few seconds
   * each, each committed on its own), so the run is kept short.
   */
  bulkDraftMax: 20,
  /** Output ceiling per call (tokens); also what the pre-call cap check assumes will be spent. */
  maxOutputTokens: 1_000,
  /** Characters per token used only to estimate input size before the call (conservative: 3). */
  charsPerToken: 3,
  requestTimeoutMs: 60_000,
  anthropicVersion: "2023-06-01",
  apiUrl: "https://api.anthropic.com/v1/messages",
} as const;
