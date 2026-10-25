import type { Db, Tx } from "@opengmb/db";
import { microOf, platformLimit } from "./platform-limits";

/** The platform's monthly AI cap in micro-USD, read at use time (database, then AI_MONTHLY_BUDGET_USD, then the default). */
export async function effectiveCapMicroUsd(
  db: Db | Tx,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  return microOf(await platformLimit(db, "ai_monthly_budget_usd", env));
}
