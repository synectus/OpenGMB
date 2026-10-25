/**
 * What each service reads from its environment, printed at startup (non-secret values as they
 * are, secrets as present / missing / invalid and never their value), and a fail-fast check that
 * every required secret is there. The running process is the only place the effective config
 * can be read, so this is how a deploy is verified: look at the first lines of the service log.
 */

import { isEmailVerificationRequired } from "../auth";
import { signupMode } from "../signup";
import { HOSTED_SECRETS, hostedWebStartupFields } from "./startup-hosted";
import { alertEmail } from "./monitoring";
import { DATAFORSEO_ENDPOINTS } from "./geogrid";
import {
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_QUEUE_OPTIONS,
  WEBHOOK_REVIEW_MAX_AGE_DAYS,
} from "./webhooks";
import { aiIsOn } from "../ai/model";
import { microToUsd, platformCapMicroUsd } from "../ai/money";
import { lockoutConfig, publicLimits } from "../limits/config";

export type ServiceName = "web" | "worker" | "mcp";

export class StartupConfigError extends Error {
  constructor(
    public readonly service: ServiceName,
    public readonly problems: string[],
  ) {
    super(
      `${service} cannot start, fix the environment: ${problems.join("; ")}. ` +
        `Set these on the service at your hosting provider (environment variables) and redeploy.`,
    );
    this.name = "StartupConfigError";
  }
}

type Env = Record<string, string | undefined>;
type SecretState = "present" | "missing" | "invalid";

type Secret = {
  name: string;
  /** Services that cannot run without it. */
  requiredBy: readonly ServiceName[];
  /** Returns a reason when a present value is unusable (wrong length, placeholder). */
  check?: (value: string, env: Env) => string | null;
};

const PLACEHOLDER = /^replace-with/i;
const base64Bytes = (v: string) => Buffer.from(v, "base64").length;

const placeholderInProd = (v: string, env: Env) =>
  env.NODE_ENV === "production" && PLACEHOLDER.test(v)
    ? "still the .env.example placeholder"
    : null;

const SECRETS: readonly Secret[] = [
  { name: "DATABASE_URL", requiredBy: ["web", "worker", "mcp"] },
  {
    name: "ENCRYPTION_KEY",
    requiredBy: ["web", "worker", "mcp"],
    check: (v, env) =>
      placeholderInProd(v, env) ??
      (base64Bytes(v) === 32 ? null : "must be base64 for exactly 32 bytes"),
  },
  {
    name: "AUDIT_CHECKPOINT_KEY",
    requiredBy: ["web", "worker", "mcp"],
    check: (v, env) =>
      placeholderInProd(v, env) ??
      (base64Bytes(v) >= 32 ? null : "must be base64 for at least 32 bytes"),
  },
  {
    name: "BETTER_AUTH_SECRET",
    requiredBy: ["web"],
    check: (v, env) =>
      placeholderInProd(v, env) ?? (v.length >= 32 ? null : "must be at least 32 characters"),
  },
  // Needed only once Google is live: sign-in with Google and every Business Profile call.
  { name: "GOOGLE_CLIENT_ID", requiredBy: [] },
  { name: "GOOGLE_CLIENT_SECRET", requiredBy: [] },
  // Optional features; missing turns the feature off (the text says what).
  { name: "RESEND_API_KEY", requiredBy: [] },
  { name: "ANTHROPIC_API_KEY", requiredBy: [] },
  { name: "PUBSUB_AUDIENCE", requiredBy: [] },
  { name: "PUBSUB_SERVICE_ACCOUNT_EMAIL", requiredBy: [] },
  { name: "PUBSUB_TOPIC", requiredBy: [] },
  { name: "GOOGLE_MAPS_BROWSER_KEY", requiredBy: [] },
  { name: "DATAFORSEO_LOGIN", requiredBy: [] },
  { name: "DATAFORSEO_PASSWORD", requiredBy: [] },
  { name: "GOOGLE_PLACES_SERVER_KEY", requiredBy: [] },
  { name: "PIXABAY_API_KEY", requiredBy: [] },
  { name: "OPENAI_API_KEY", requiredBy: [] },
  ...HOSTED_SECRETS,
];

/** Secrets that must also be present because of how the service is configured. */
function extraRequired(env: Env): string[] {
  const live = (env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock") === "live";
  if (!live) return [];
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
}

/** Host and database name of a connection string, never the user or password. */
export function describeDatabase(url: string | undefined): string {
  if (!url) return "missing";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "invalid (not a URL)";
  }
}

export type StartupReport = {
  service: ServiceName;
  /** Lines to print, in order. Contain no secret values. */
  lines: string[];
  /** Required secrets that are missing or unusable, each with the reason. */
  problems: string[];
  secrets: Record<string, SecretState>;
};

export function buildStartupReport(service: ServiceName, env: Env = process.env): StartupReport {
  const mode = env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock";
  const writes = env.GOOGLE_BUSINESS_WRITES?.trim() || "off";
  const nodeEnv = env.NODE_ENV || "(unset)";
  const extra = new Set(extraRequired(env));

  const secrets: Record<string, SecretState> = {};
  const problems: string[] = [];
  for (const s of SECRETS) {
    const value = env[s.name]?.trim();
    let state: SecretState = value ? "present" : "missing";
    const required = s.requiredBy.includes(service) || extra.has(s.name);
    if (value && s.check) {
      const bad = s.check(value, env);
      if (bad) {
        state = "invalid";
        if (required) problems.push(`${s.name} ${bad}`);
      }
    }
    if (state === "missing" && required) problems.push(`${s.name} is not set`);
    secrets[s.name] = state;
  }

  const dfsBase = env.DATAFORSEO_API_BASE?.trim();
  if (dfsBase && !(DATAFORSEO_ENDPOINTS.hosts as readonly string[]).includes(dfsBase)) {
    problems.push(`DATAFORSEO_API_BASE must be empty or one of ${DATAFORSEO_ENDPOINTS.hosts.join(", ")}`);
  }

  const modeValid = mode === "mock" || mode === "live";
  if (!modeValid) problems.push(`GOOGLE_BUSINESS_API_MODE "${mode}" must be mock or live`);
  if (mode === "live" && writes !== "off" && writes !== "live") {
    problems.push(`GOOGLE_BUSINESS_WRITES "${writes}" must be off or live`);
  }

  const lines = [
    `[startup] ${service}: node_env=${nodeEnv} google_mode=${mode} google_writes=${mode === "live" ? writes : "n/a (mock)"}`,
    `[startup] ${service}: database=${describeDatabase(env.DATABASE_URL)}`,
  ];
  if (service === "web") {
    const lock = lockoutConfig(env);
    const pub = publicLimits(env).perMinute;
    lines.push(
      `[startup] web: email_verification=${isEmailVerificationRequired(env.REQUIRE_EMAIL_VERIFICATION, env.NODE_ENV) ? "required" : "off"}${isEmailVerificationRequired(env.REQUIRE_EMAIL_VERIFICATION, env.NODE_ENV) && !(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim()) ? " (no email provider, so confirmation links appear in this service log)" : ""} lockout=${lock.failures}_failures_per_${lock.windowMinutes}_min public_per_min=${Object.entries(
        pub,
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(",")}`,
    );
    lines.push(
      `[startup] web: base_url=${env.BETTER_AUTH_URL || "missing"} signup=${signupMode(env)} mcp_public_url=${env.MCP_PUBLIC_URL?.trim() || "unset"} mcp_internal_url=${env.MCP_INTERNAL_URL?.trim() || "unset (default http://localhost:3100)"}${hostedWebStartupFields(env, secrets)}`,
    );
  } else if (service === "worker") {
    lines.push(
      `[startup] worker: port=${env.WORKER_PORT || 3200} public_url=${env.WORKER_PUBLIC_URL || "unset"} email_from=${env.EMAIL_FROM ? "set" : "unset"} pubsub_webhook=${secrets.PUBSUB_AUDIENCE === "present" && secrets.PUBSUB_SERVICE_ACCOUNT_EMAIL === "present" ? "on" : "off (answers 503)"} email_digest=${secrets.RESEND_API_KEY === "present" ? "on" : "off"} webhooks: retry_limit=${WEBHOOK_QUEUE_OPTIONS.retryLimit} max_age_days=${WEBHOOK_REVIEW_MAX_AGE_DAYS} retention_days=${WEBHOOK_DELIVERY_RETENTION_DAYS}`,
    );
  } else {
    lines.push(`[startup] mcp: port=${env.MCP_PORT || 3100}`);
  }
  if (service !== "mcp") {
    lines.push(
      `[startup] ${service}: ai=${aiIsOn(env) ? "on" : "off"} ai_monthly_budget_usd=${microToUsd(platformCapMicroUsd(env))}`,
    );
  }
  lines.push(
    `[startup] ${service}: alerts=${alertEmail(env) && env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim() ? "email" : "log only"} alert_email=${alertEmail(env) ? "set" : "unset"}`,
  );
  lines.push(
    `[startup] ${service}: secrets ` +
      Object.entries(secrets)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
  );
  if (nodeEnv === "production" && mode === "mock") {
    lines.push(
      `[startup] ${service}: WARNING production is running with GOOGLE_BUSINESS_API_MODE=mock`,
    );
  }
  return { service, lines, problems, secrets };
}

/**
 * Print the effective config and throw StartupConfigError (listing every problem at once) when a
 * required secret is missing or unusable. Call first thing in each service entry point.
 */
export function reportStartupConfig(
  service: ServiceName,
  env: Env = process.env,
  log: (line: string) => void = (l) => console.log(l),
): StartupReport {
  const report = buildStartupReport(service, env);
  for (const line of report.lines) log(line);
  if (report.problems.length > 0) throw new StartupConfigError(service, report.problems);
  return report;
}
