import type { Db, Tx } from "@opengmb/db";
import { PLATFORM_LIMITS, type PlatformLimitKey } from "../config/platform-limits";

type Env = Record<string, string | undefined>;
export type LimitSource = "app" | "env" | "default";

/** Community edition: limits come from the environment, else the default. */
export async function readPlatformLimit(
  _db: Db | Tx,
  key: PlatformLimitKey,
  env: Env = process.env,
): Promise<{ value: number; source: LimitSource }> {
  const raw = env[PLATFORM_LIMITS[key].env]?.trim();
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 0) return { value: n, source: "env" };
  return { value: PLATFORM_LIMITS[key].default, source: "default" };
}

export async function platformLimit(db: Db | Tx, key: PlatformLimitKey, env: Env = process.env): Promise<number> {
  return (await readPlatformLimit(db, key, env)).value;
}

export const microOf = (usd: number) => Math.round(usd * 1_000_000);
