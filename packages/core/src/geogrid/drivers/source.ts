import { DATAFORSEO_ENDPOINTS } from "../../config/geogrid";
import { getIntegrationFresh, integrationEnv } from "../../integrations";
import type { DfsCredentials } from "./fixtures";

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

/** Our own DataForSEO credentials, read fresh on every call so a key change applies at once. */
export async function platformDataForSeoCredentials(): Promise<DfsCredentials | null> {
  const login = (await getIntegrationFresh("DATAFORSEO_LOGIN"))?.trim();
  const password = (await getIntegrationFresh("DATAFORSEO_PASSWORD"))?.trim();
  return login && password ? { login, password } : null;
}

