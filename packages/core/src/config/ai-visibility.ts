/**
 * K5: AI search visibility. How ChatGPT, Gemini, Perplexity and Google AI Overviews answer local prompts.
 * Every external price carries its source URL and the date it was checked; logic reads these, never a literal.
 */
export const AI_ENGINES = ["chatgpt", "gemini", "perplexity", "ai_overview"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

export const AI_VISIBILITY = {
  /** Our choice, not an external fact: prompts per engine per weekly check. */
  promptsPerCheck: 3,
  /** Our choice: the prompts are built from the category, the city and then the tracked keywords. */
  maxPromptChars: 200,
  /** Our choice: the answer text kept per result. */
  excerptChars: 600,
  /** Our choice: how often an enabled location is checked. */
  schedule: "weekly",
  /** Our choice: engines a location starts with when it is switched on. */
  defaultEngines: ["chatgpt", "gemini", "perplexity", "ai_overview"] as readonly AiEngine[],
  /** Give up on one call after this long (DataForSEO Live allows up to 120 s). */
  timeoutMs: 125_000,
  languageCode: "en",
  /** Per engine: where to call, what one call costs DataForSEO (USD), and where that was read. */
  engines: {
    chatgpt: {
      label: "ChatGPT",
      path: "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
      /** LLM Scraper, Live: $0.004 per result page (flat; the docs' sample response also shows cost 0.004). */
      unitUsd: 0.004,
      sourceUrl: "https://dataforseo.com/pricing/ai-optimization/llm-scraper",
      docsUrl: "https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced/",
      verifiedOn: "2026-10-24",
    },
    gemini: {
      label: "Gemini",
      path: "/v3/ai_optimization/gemini/llm_scraper/live/advanced",
      unitUsd: 0.004,
      sourceUrl: "https://dataforseo.com/pricing/ai-optimization/llm-scraper",
      docsUrl: "https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced/",
      verifiedOn: "2026-10-24",
    },
    perplexity: {
      label: "Perplexity",
      path: "/v3/ai_optimization/perplexity/llm_responses/live",
      model: "sonar",
      /**
       * LLM Responses, Live: $0.0006 per task plus the model's token cost (`money_spent`, not published). Reserved at the
       * $0.01 advance the pricing page states for a task, then settled to the cost DataForSEO reports.
       */
      unitUsd: 0.0106,
      sourceUrl: "https://dataforseo.com/pricing/ai-optimization/llm-responses",
      docsUrl: "https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live/",
      verifiedOn: "2026-10-24",
    },
    ai_overview: {
      label: "Google AI Overviews",
      path: "/v3/serp/google/organic/live/advanced",
      /** Google Organic SERP, Live: $0.002 per SERP, plus $0.002 for `load_async_ai_overview` (returned when no overview is shown). */
      unitUsd: 0.004,
      sourceUrl: "https://dataforseo.com/pricing/serp/google-organic-serp-api",
      docsUrl: "https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/",
      verifiedOn: "2026-10-24",
    },
  },
  note: "Live mode, one call per prompt and engine. Costs checked 2026-10-24; the Perplexity token cost is not published, so its unit is the documented per-task advance and the charge settles to the cost each response reports.",
} as const;

/** DataForSEO's cost of one weekly check: prompts x the unit price of every chosen engine. */
export function checkCostUsd(engines: readonly AiEngine[], prompts: number = AI_VISIBILITY.promptsPerCheck): number {
  return prompts * engines.reduce((sum, e) => sum + AI_VISIBILITY.engines[e].unitUsd, 0);
}
