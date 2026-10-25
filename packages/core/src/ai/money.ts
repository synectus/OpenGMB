import { AI_DEFAULTS, AI_MODELS, type AiModelId } from "../config/ai-models";

/** Cost of one call in micro-USD, rounded up so a cap can never be under-counted. */
export function costMicroUsd(model: AiModelId, inputTokens: number, outputTokens: number): number {
  const m = AI_MODELS[model];
  const p = inputTokens > m.tierTokens ? m.long : m.base;
  return Math.ceil(
    (inputTokens * p.inputPerMTokMicroUsd + outputTokens * p.outputPerMTokMicroUsd) / 1_000_000,
  );
}

/** Worst case for a call before it is made: estimated input tokens plus the full output ceiling. */
export function estimateMaxCostMicroUsd(model: AiModelId, promptChars: number, maxTokens: number): number {
  return costMicroUsd(model, Math.ceil(promptChars / AI_DEFAULTS.charsPerToken), maxTokens);
}

export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);
export const microToUsd = (micro: number): number => micro / 1_000_000;

/** Platform monthly cap in micro-USD from AI_MONTHLY_BUDGET_USD (injectable env). Bad values fall back to the default. */
export function platformCapMicroUsd(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AI_MONTHLY_BUDGET_USD?.trim();
  const n = raw ? Number(raw) : NaN;
  return usdToMicro(Number.isFinite(n) && n >= 0 ? n : AI_DEFAULTS.platformMonthlyBudgetUsd);
}

/** First instant of the UTC calendar month containing `now`. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
