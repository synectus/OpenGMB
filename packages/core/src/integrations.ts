import type { Db } from "@opengmb/db";
import { configureLimitEvents } from "./limits/alerts";

/** Community edition: every key comes from the environment (the .env file), nothing is stored in the app. */
export const INTEGRATION_KEYS = [
  "GOOGLE_MAPS_BROWSER_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "PUBSUB_AUDIENCE",
  "PUBSUB_SERVICE_ACCOUNT_EMAIL",
  "PUBSUB_TOPIC",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "ANTHROPIC_API_KEY",
  "PIXABAY_API_KEY",
  "OPENAI_API_KEY",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "GOOGLE_PLACES_SERVER_KEY",
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

type Env = Record<string, string | undefined>;

export function getIntegration(key: IntegrationKey, env: Env = process.env): string | undefined {
  return env[key]?.trim() || undefined;
}

export async function getIntegrationFresh(key: IntegrationKey, env: Env = process.env): Promise<string | undefined> {
  return getIntegration(key, env);
}

export const integrationEnv = (env: Env = process.env): Env => ({ ...env });

export async function startIntegrations(service: string, db: Db): Promise<void> {
  configureLimitEvents(db);
  console.log(`[startup] ${service}: integration keys are read from the environment`);
}
