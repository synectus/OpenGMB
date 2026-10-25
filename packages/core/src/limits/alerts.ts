import { monitorState, type Db } from "@opengmb/db";
import { LIMIT_ALERTS, eventAlertLimits } from "../config/platform-limits";
import { sendAlert } from "../monitoring/alert";
import { platformDayToDateUsd } from "../geogrid/cost";
import { platformSpentMicroUsd } from "../ai/usage";
import { rankSource } from "../geogrid/drivers/source";
import { bumpCounter, utcDayKey, utcHourKey } from "./counters";
import { platformLimit, microOf } from "./platform-limits";

type Alert = (subject: string, text: string) => Promise<unknown>;

/**
 * Claims one alert for a period by inserting its key into monitor_state. True for the first caller
 * only, so a threshold sends one email per period however often it is checked, from any process.
 */
export async function claimLimitAlert(db: Db, name: string, period: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .insert(monitorState)
    .values({ key: `limit_alert:${name}:${period}`, value: now.toISOString(), updatedAt: now })
    .onConflictDoNothing()
    .returning({ key: monitorState.key });
  return rows.length > 0;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export type LimitCheckDeps = {
  now?: Date;
  alert?: Alert;
  /** USD left on our DataForSEO account, or null when it could not be read. Tests inject this; no live call. */
  balance?: () => Promise<number | null>;
  env?: Record<string, string | undefined>;
  /** Spend readers; default to the real tables. Tests inject numbers because other test files clear those tables. */
  spend?: { aiMicroUsd?: () => Promise<number>; dfsUsd?: () => Promise<number> };
};

/**
 * Worker tick: raises the usage alerts. AI platform budget at 80% and 100% (a month), DataForSEO daily
 * cap at 80% (a day), DataForSEO account balance under its floor (checked once a day). Each crossing
 * is claimed once per period. Returns the names of the alerts sent.
 */
export async function checkLimitAlerts(db: Db, deps: LimitCheckDeps = {}): Promise<string[]> {
  const now = deps.now ?? new Date();
  const alert = deps.alert ?? sendAlert;
  const env = deps.env ?? process.env;
  const month = now.toISOString().slice(0, 7);
  const day = utcDayKey(now);
  const sent: string[] = [];
  const raise = async (name: string, period: string, subject: string, text: string) => {
    if (!(await claimLimitAlert(db, name, period, now))) return;
    sent.push(name);
    await alert(subject, text).catch((e: unknown) => console.error("[limits] alert failed", e));
  };

  const aiCap = microOf(await platformLimit(db, "ai_monthly_budget_usd", env));
  if (aiCap > 0) {
    const spent = await (deps.spend?.aiMicroUsd ?? (() => platformSpentMicroUsd(db as never, now)))();
    const frac = spent / aiCap;
    const line = `AI spend this month is ${usd(spent / 1e6)} of the ${usd(aiCap / 1e6)} platform budget. Change it in Settings > Integrations > Platform limits.`;
    if (frac >= LIMIT_ALERTS.fullFraction) {
      await raise("ai_100", month, "AI platform budget reached", `${line} AI drafts and replies are refused for every account until the month ends or the budget is raised.`);
    }
    if (frac >= LIMIT_ALERTS.warnFraction) {
      await raise("ai_80", month, "AI platform budget at 80%", line);
    }
  }

  const dfsCap = await platformLimit(db, "dfs_daily_cap_usd", env);
  if (dfsCap > 0) {
    const spent = await (deps.spend?.dfsUsd ?? (() => platformDayToDateUsd(db, now)))();
    if (spent / dfsCap >= LIMIT_ALERTS.warnFraction) {
      await raise(
        "dfs_80",
        day,
        "DataForSEO daily cap at 80%",
        `DataForSEO spend today is ${usd(spent)} of the ${usd(dfsCap)} daily cap. Change it in Settings > Integrations > Platform limits.`,
      );
    }
  }

  // Balance: one look a day, only against the live service (the sandbox returns a made-up balance).
  const getBalance = deps.balance ?? (rankSource() === "live" ? liveBalance : null);
  if (getBalance && (await claimLimitAlert(db, "dfs_balance_checked", day, now))) {
    const balance = await getBalance().catch(() => null);
    if (balance !== null) {
      await db
        .insert(monitorState)
        .values({ key: "dfs_balance", value: String(balance), updatedAt: now })
        .onConflictDoUpdate({ target: monitorState.key, set: { value: String(balance), updatedAt: now } });
      const floor = await platformLimit(db, "dfs_balance_alert_usd", env);
      if (balance < floor) {
        await raise(
          "dfs_balance",
          day,
          "DataForSEO balance is low",
          `The DataForSEO account balance is ${usd(balance)}, under the ${usd(floor)} alert level. Rank scans stop when it reaches zero. Top it up at dataforseo.com.`,
        );
      }
    }
  }
  return sent;
}

async function liveBalance(): Promise<number | null> {
  const { liveDataForSeoTransport } = await import("../geogrid/drivers/live-dataforseo");
  const { dataForSeoBaseUrl, platformDataForSeoCredentials } = await import("../geogrid/drivers/source");
  const r = await liveDataForSeoTransport({ baseUrl: dataForSeoBaseUrl(), credentials: platformDataForSeoCredentials }).checkCredentials!();
  return r.ok && typeof r.balanceUsd === "number" ? r.balanceUsd : null;
}

export type LimitEventKind = "google_org_limited" | "email_failed";
const EVENT_TEXT: Record<LimitEventKind, { subject: string; what: string }> = {
  google_org_limited: {
    subject: "Google per-account request limit reached often",
    what: "accounts were refused because they hit their own Google request limit",
  },
  email_failed: {
    subject: "Email sending is failing",
    what: "emails failed to send (Resend error or rate limit)",
  },
};

/**
 * Counts one event in the current UTC hour on the root connection (so a rolled-back action keeps its
 * count) and, when the hour's count passes its limit, sends one alert for that hour. Never throws.
 */
export async function recordLimitEvent(
  db: Db,
  kind: LimitEventKind,
  deps: { now?: Date; alert?: Alert; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  try {
    const now = deps.now ?? new Date();
    const hour = utcHourKey(now);
    const count = await bumpCounter(db, "platform", `event:${kind}`, hour);
    const limits = eventAlertLimits(deps.env);
    const limit = kind === "email_failed" ? limits.emailFailuresPerHour : limits.googleOrgLimitedPerHour;
    if (count <= limit) return;
    if (!(await claimLimitAlert(db, kind, hour, now))) return;
    const t = EVENT_TEXT[kind];
    await (deps.alert ?? sendAlert)(t.subject, `More than ${limit} ${t.what} in the hour starting ${hour}:00 UTC (${count} so far).`);
  } catch (e) {
    console.error("[limits] could not record event", e instanceof Error ? e.message : e);
  }
}

let eventDb: Db | null = null;
let alerting = false;
/** Boot: register the connection the event hook writes through (each service calls this once). */
export function configureLimitEvents(db: Db): void {
  eventDb = db;
}

/** Fire-and-forget hook for places without a database handle (the Google throttler, the Resend sender). */
export function reportLimitEvent(kind: LimitEventKind): void {
  if (!eventDb || alerting) return;
  alerting = kind === "email_failed";
  void recordLimitEvent(eventDb, kind).finally(() => {
    alerting = false;
  });
}
