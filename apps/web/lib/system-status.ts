// Copy decisions for /settings/status. Client-safe (the shell pill imports LIVE_STATE).
import type { TimeFormat } from "./time-format";
import type { LiveRow, LiveState, LiveStatus } from "./live-status";

/** Badge text and token classes per state; shared by the "What is live" pill and the page. */
export const LIVE_STATE: Record<LiveState, { label: string; className: string }> = {
  live: { label: "Live", className: "bg-good-bg text-good" },
  off: { label: "Off", className: "bg-warn-bg text-warn" },
  simulated: { label: "Simulated", className: "bg-info-bg text-info" },
  not_set_up: { label: "Not set up", className: "bg-warn-bg text-warn" },
  misconfigured: { label: "Misconfigured", className: "bg-bad-bg text-bad" },
  sample: { label: "Sample data", className: "bg-secondary text-secondary-foreground" },
};

/** The rows liveStatus counts as not live (sample data is labelled where it shows: PR #2). */
export function notLiveSummary(s: LiveStatus): string {
  const labels = s.rows.filter((r) => r.state !== "live" && r.state !== "sample").map((r) => r.label);
  if (labels.length === 0) return "Everything is live";
  return `${labels.length === 1 ? "1 part" : `${labels.length} parts`} not live: ${labels.join(", ")}`;
}

export function turnsOn(row: LiveRow, showSettingNames: boolean): string {
  if (row.state === "live") return "Already on.";
  const setting = showSettingNames ? row.setting : null;
  if (row.state === "misconfigured") {
    return setting ? `Set ${setting} to a recognised value.` : "An owner fixes this setting for this server.";
  }
  switch (row.key) {
    case "google":
      return "Google approves API access for the project, then an owner switches this server to live Google data.";
    case "writes":
      if (row.state === "simulated") return "Turns on with Google data, once an owner also sets writes to live.";
      return setting
        ? `An owner sets ${setting} to live for this server.`
        : "An owner turns publishing to Google on for this server.";
    case "pubsub":
      return "Google Pub/Sub push needs an organization policy exception on the Google Cloud project, a topic with a push subscription to this app, and the My Business Notifications API turned on. Then a platform admin applies it to the connected accounts in Settings > Integrations.";
    case "rank":
      return "A DataForSEO connection.";
    case "email":
      return "An email provider key and a sending address.";
  }
}

export function jobResultText(j: { result: string; note: string | null }): string {
  if (j.result === "never") return "No run recorded yet";
  return j.result === "ok" && j.note ? j.note : j.result;
}

export function lateText(j: { label: string; lastRunAt: string | null }, tf: TimeFormat): string {
  return `${j.label} has not run since ${j.lastRunAt ? tf.dateTime(j.lastRunAt) : ""}. The worker may be down.`;
}

export function reviewsCell(
  l: {
  status: string;
  needsRelink: boolean;
  reviewsLastStatus: string | null;
  reviewsLastSyncedAt: string | null;
    workspaceId: string;
  },
  tf: TimeFormat,
): string {
  if (l.needsRelink) return "Not linked to Google";
  if (l.status !== "active") return "Inactive, not synced";
  if (l.reviewsLastStatus === "pending") return "Waiting for the worker";
  return l.reviewsLastSyncedAt ? tf.dateTime(l.reviewsLastSyncedAt, l.workspaceId) : "Never";
}
