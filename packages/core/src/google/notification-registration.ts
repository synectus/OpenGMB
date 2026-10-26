import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  googleConnections,
  googleNotificationRegistrations,
  locations,
  type Db,
} from "@opengmb/db";
import { GOOGLE_NOTIFICATIONS } from "../config/google-notifications";
import { getIntegration } from "../integrations";
import { enqueueJob } from "../jobs";
import { createGoogleClient } from "./factory";
import type { GoogleClient, GoogleNotificationSetting } from "./client";
import { GoogleApiError, GoogleWritesDisabledError } from "./errors";
import { orgIsActive } from "../account-state";

export const NOTIFICATION_REGISTER_QUEUE = "google-notifications.register";
/** Once a day, UTC. */
export const NOTIFICATION_REGISTER_CRON = "17 4 * * *";

export type RegisterJob = {
  /** Only this connection; absent means every connection. */
  connectionId?: string;
  /**
   * "all": every Google account the connection can see (a person just connected it, or an admin
   * pressed Apply). "relevant": only accounts with an active imported location or an earlier
   * registration row (the daily sweep, which must not take over accounts nobody imported).
   */
  scope: "all" | "relevant";
};

export type RegisterSummary = {
  skipped: "no_topic" | null;
  accounts: number;
  registered: number;
  unchanged: number;
  failed: number;
};

/** Plain-language reason for a failed call. Never includes tokens or the raw Google body. */
export function registrationErrorMessage(e: unknown): string {
  if (e instanceof GoogleWritesDisabledError) {
    return "Publishing to Google is off on this server (GOOGLE_BUSINESS_WRITES), so notifications cannot be registered.";
  }
  if (e instanceof GoogleApiError) {
    const err = (e.body as { error?: { status?: unknown; message?: unknown; details?: { reason?: unknown }[] } } | null)?.error;
    const reason = (err?.details ?? []).map((d) => d?.reason);
    const message = typeof err?.message === "string" ? err.message : "";
    if (
      e.status === 403 &&
      (reason.includes("SERVICE_DISABLED") || /has not been used|is disabled|SERVICE_DISABLED/i.test(message))
    ) {
      return `The ${GOOGLE_NOTIFICATIONS.apiName} is not enabled in your Google Cloud project. Enable it in the Google Cloud console (APIs & Services, Library), wait a few minutes, then apply again.`;
    }
    if (e.status === 403) {
      return "Google refused: the connected Google user cannot manage notifications for this account, or the app has no access to this API yet.";
    }
    if (e.status === 400 || e.status === 404) {
      return `Google could not use the topic. Check that PUBSUB_TOPIC is the full name (projects/<project>/topics/<topic>), the topic exists, and ${GOOGLE_NOTIFICATIONS.publisherServiceAccount} has the Pub/Sub Publisher role on it.${message ? ` Google said: ${message.slice(0, 200)}` : ""}`;
    }
    return `Google returned an error (${e.status}). It will be tried again at the next daily check.`;
  }
  return e instanceof Error && e.message ? e.message.slice(0, 300) : "Unknown error";
}

const sameTypes = (a: string[] | undefined, b: readonly string[]) =>
  [...(a ?? [])].sort().join(",") === [...b].sort().join(",");

/**
 * Point one Google account's Business Profile notifications at our topic. Idempotent: reads the
 * current setting first and only writes when the topic or types differ. Returns what happened.
 */
export async function registerAccount(
  client: Pick<GoogleClient, "getNotificationSetting" | "updateNotificationSetting">,
  accountName: string,
  topic: string,
): Promise<"registered" | "unchanged"> {
  const current = await client.getNotificationSetting(accountName);
  if (current.pubsubTopic === topic && sameTypes(current.notificationTypes, GOOGLE_NOTIFICATIONS.notificationTypes)) {
    return "unchanged";
  }
  const setting: GoogleNotificationSetting = {
    name: GOOGLE_NOTIFICATIONS.settingPath(accountName),
    pubsubTopic: topic,
    notificationTypes: GOOGLE_NOTIFICATIONS.notificationTypes,
  };
  await client.updateNotificationSetting(accountName, setting, GOOGLE_NOTIFICATIONS.updateMask);
  return "registered";
}

async function record(
  db: Db,
  row: { orgId: string; connectionId: string; accountName: string },
  outcome: { topic: string; error: null } | { topic: string; error: string },
) {
  const now = new Date();
  const ok = outcome.error === null;
  await db
    .insert(googleNotificationRegistrations)
    .values({
      ...row,
      topic: outcome.topic,
      registeredAt: ok ? now : null,
      lastAttemptAt: now,
      lastError: outcome.error,
    })
    .onConflictDoUpdate({
      target: googleNotificationRegistrations.accountName,
      set: {
        orgId: row.orgId,
        connectionId: row.connectionId,
        topic: outcome.topic,
        lastAttemptAt: now,
        lastError: outcome.error,
        // A failed attempt keeps the earlier success time; a success sets it.
        ...(ok ? { registeredAt: now } : {}),
      },
    });
}

/** Register the accounts one connection can see (see RegisterJob.scope). One failing account does not stop the rest. */
export async function registerConnectionNotifications(
  db: Db,
  connection: { id: string; orgId: string; refreshTokenEnc: string },
  scope: RegisterJob["scope"],
  deps: { client?: Pick<GoogleClient, "listAccounts" | "getNotificationSetting" | "updateNotificationSetting"> } = {},
): Promise<RegisterSummary> {
  const topic = getIntegration("PUBSUB_TOPIC");
  const summary: RegisterSummary = { skipped: null, accounts: 0, registered: 0, unchanged: 0, failed: 0 };
  if (!topic) return { ...summary, skipped: "no_topic" };

  const client = deps.client ?? createGoogleClient({ db, connection });
  const row = (accountName: string) => ({ orgId: connection.orgId, connectionId: connection.id, accountName });
  let names: string[];
  try {
    names = (await client.listAccounts()).accounts.map((a) => a.name).filter((n) => GOOGLE_NOTIFICATIONS.accountNamePattern.test(n));
  } catch (e) {
    console.error(`[notifications] connection ${connection.id}: listing Google accounts failed: ${registrationErrorMessage(e)}`);
    summary.failed += 1;
    return summary;
  }
  if (scope === "relevant" && names.length) {
    const used = await db
      .select({ a: locations.googleAccountName })
      .from(locations)
      .where(and(inArray(locations.googleAccountName, names), eq(locations.status, "active"), isNotNull(locations.googleAccountName)));
    const known = await db
      .select({ a: googleNotificationRegistrations.accountName })
      .from(googleNotificationRegistrations)
      .where(inArray(googleNotificationRegistrations.accountName, names));
    const keep = new Set([...used.map((r) => r.a), ...known.map((r) => r.a)]);
    names = names.filter((n) => keep.has(n));
  }
  summary.accounts = names.length;
  for (const accountName of names) {
    try {
      const r = await registerAccount(client, accountName, topic);
      summary[r] += 1;
      await record(db, row(accountName), { topic, error: null });
    } catch (e) {
      summary.failed += 1;
      await record(db, row(accountName), { topic, error: registrationErrorMessage(e) });
    }
  }
  return summary;
}

/** The job body: one connection (just connected) or all of them (admin button, daily sweep). */
export async function runNotificationRegistration(db: Db, job: RegisterJob): Promise<RegisterSummary> {
  const total: RegisterSummary = { skipped: null, accounts: 0, registered: 0, unchanged: 0, failed: 0 };
  if (!getIntegration("PUBSUB_TOPIC")) return { ...total, skipped: "no_topic" };
  const conns = await db
    .select({ id: googleConnections.id, orgId: googleConnections.orgId, refreshTokenEnc: googleConnections.refreshTokenEnc })
    .from(googleConnections)
    // AP3b: a suspended or deleted org's accounts are left alone; the daily run repairs them after unsuspend.
    .where(and(job.connectionId ? eq(googleConnections.id, job.connectionId) : undefined, orgIsActive(googleConnections.orgId)));
  for (const c of conns) {
    const s = await registerConnectionNotifications(db, c, job.scope);
    total.accounts += s.accounts;
    total.registered += s.registered;
    total.unchanged += s.unchanged;
    total.failed += s.failed;
  }
  return total;
}

/** Queue a registration run. Best effort for the connect flow: a missing queue must not break signing in to Google. */
export async function enqueueNotificationRegistration(db: Db, job: RegisterJob): Promise<boolean> {
  if (!getIntegration("PUBSUB_TOPIC")) return false;
  try {
    await db.transaction((tx) => enqueueJob(tx, NOTIFICATION_REGISTER_QUEUE, job));
    return true;
  } catch (e) {
    console.error("[notifications] could not queue registration", e instanceof Error ? e.message : e);
    return false;
  }
}
