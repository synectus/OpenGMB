import { z } from "zod";
import { AccessError } from "../actor";
import { isPlatformAdmin } from "../config/platform-admin";
import { MONITORING } from "../config/monitoring";
import { defineAction } from "../registry";
import { alertDelivery } from "../monitoring/alert";
import { recentErrors } from "../monitoring/errors";
import { googleUsage } from "../monitoring/google-usage";
import { lastHeartbeat } from "../monitoring/worker";

// System health (H2). The error list, worker heartbeat and Google call counts belong to the whole
// platform, not to one organization, so like organization invites only platform administrators
// (PLATFORM_ADMIN_EMAILS) may read them, and the owner/admin permission gate runs first.
export const monitoringOverview = defineAction({
  name: "monitoring.overview",
  description:
    "System health for the whole server (platform administrators only; everyone else gets FORBIDDEN): the worker's last heartbeat and whether it is stale, how alerts are delivered (email to ALERT_EMAIL, or only written to the log), the most recent distinct server errors with how often each was seen (messages are stripped of secrets and personal data), and Google Business API calls per day and method against the 300 requests per minute limit. Read-only, never calls Google.",
  input: z.object({}),
  output: z.object({
    worker: z.object({
      lastHeartbeatAt: z.string().nullable(),
      state: z.enum(["unknown", "ok", "down"]),
      staleAfterMinutes: z.number(),
    }),
    alertDelivery: z.enum(["email", "log"]),
    errors: z.array(
      z.object({
        fingerprint: z.string(),
        source: z.enum(["web", "worker", "mcp"]),
        message: z.string(),
        count: z.number(),
        firstSeenAt: z.string(),
        lastSeenAt: z.string(),
        lastAlertedAt: z.string().nullable(),
      }),
    ),
    google: z.object({
      limitPerMinute: z.number(),
      busiestMinuteLastHour: z.number(),
      days: z.array(
        z.object({
          day: z.string(),
          total: z.number(),
          methods: z.array(z.object({ method: z.string(), calls: z.number() })),
        }),
      ),
    }),
  }),
  permission: "member:invite",
  kind: "read",
  async handler({ tx, actor }) {
    if (!(await isPlatformAdmin(tx, actor.userId))) {
      throw new AccessError("FORBIDDEN", "Only platform administrators can see system health");
    }
    const now = new Date();
    const beat = await lastHeartbeat(tx);
    const stale = beat ? now.getTime() - beat.getTime() > MONITORING.workerStaleMs : false;
    return {
      worker: {
        lastHeartbeatAt: beat?.toISOString() ?? null,
        state: !beat ? ("unknown" as const) : stale ? ("down" as const) : ("ok" as const),
        staleAfterMinutes: MONITORING.workerStaleMs / 60000,
      },
      alertDelivery: alertDelivery(),
      errors: (await recentErrors(tx)).map((e) => ({
        fingerprint: e.fingerprint,
        source: e.source,
        message: e.message,
        count: e.count,
        firstSeenAt: e.firstSeenAt.toISOString(),
        lastSeenAt: e.lastSeenAt.toISOString(),
        lastAlertedAt: e.lastAlertedAt?.toISOString() ?? null,
      })),
      google: await googleUsage(tx, now),
    };
  },
});
