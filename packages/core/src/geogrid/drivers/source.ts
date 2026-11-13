import { DATAFORSEO_ENDPOINTS } from "../../config/geogrid";
import { getIntegrationFresh, integrationEnv } from "../../integrations";
import { hasByoKey } from "../byo";
import type { DfsCredentials } from "./fixtures";
import type { Db, Tx } from "@opengmb/db";

export type RankSource = "fixture" | "sandbox" | "live";

type Env = Record<string, string | undefined>;

/** The DataForSEO host to use. Env only (not an in-app setting); startup validates it. */
export function dataForSeoBaseUrl(env: Env = process.env): string {
  const v = env.DATAFORSEO_API_BASE?.trim();
  return v && (DATAFORSEO_ENDPOINTS.hosts as readonly string[]).includes(v)
    ? v
    : DATAFORSEO_ENDPOINTS.hosts[0];
}

/** Where rank data comes from right now: both credentials set means live (or sandbox), else fixtures. */
export function rankSource(env: Env = integrationEnv()): RankSource {
  if (!env.DATAFORSEO_LOGIN?.trim() || !env.DATAFORSEO_PASSWORD?.trim()) return "fixture";
  return dataForSeoBaseUrl(env) === DATAFORSEO_ENDPOINTS.hosts[1] ? "sandbox" : "live";
}

/**
 * Where rank data comes from for a run that uses the organization's own key: the sandbox host when the server
 * is pointed at it, otherwise live. The server's own keys do not matter, because the run is paid with the org's key.
 */
export function byoRankSource(env: Env = integrationEnv()): RankSource {
  return dataForSeoBaseUrl(env) === DATAFORSEO_ENDPOINTS.hosts[1] ? "sandbox" : "live";
}

/** What this organization's rank runs will use right now: its own key makes them live even when the server has no key. */
export async function orgRankSource(db: Db | Tx, orgId: string, env: Env = integrationEnv()): Promise<RankSource> {
  return (await hasByoKey(db, orgId)) ? byoRankSource(env) : rankSource(env);
}

/** Our own DataForSEO credentials, read fresh on every call so a key change applies at once. */
export async function platformDataForSeoCredentials(): Promise<DfsCredentials | null> {
  const login = (await getIntegrationFresh("DATAFORSEO_LOGIN"))?.trim();
  const password = (await getIntegrationFresh("DATAFORSEO_PASSWORD"))?.trim();
  return login && password ? { login, password } : null;
}

