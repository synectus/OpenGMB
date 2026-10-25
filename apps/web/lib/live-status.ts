export type LiveState = "live" | "off" | "simulated" | "not_set_up" | "sample" | "misconfigured";
export type LiveRow = {
  key: "google" | "writes" | "pubsub" | "rank" | "email";
  label: string;
  state: LiveState;
  detail: string;
  /** Env setting behind the row; shown to owners and admins only. */
  setting: string | null;
};
export type LiveStatus = { rows: LiveRow[]; notLive: number; banner: string | null };

type Env = Record<string, string | undefined>;

/**
 * What the database says about instant review alerts. Without it the row cannot be "Live": the
 * three settings alone prove nothing about Google actually pushing.
 */
export type PushFacts = {
  /** Google accounts whose notification setting Google accepted (registered_at set). */
  registered: number;
  lastPushAt: Date | null;
  /** A push this recent counts as flowing. */
  recentDays: number;
  now?: Date;
};

/**
 * The server-wide status (rows, setting names) is for platform admins only. A viewer who is not one
 * gets null, so nothing about this server's configuration reaches their page.
 */
export function liveStatusForViewer(status: LiveStatus, platformAdmin: boolean): LiveStatus | null {
  return platformAdmin ? status : null;
}

export function liveStatus(env: Env, emailOn: boolean, push?: PushFacts): LiveStatus {
  // Same defaults as packages/core/src/google/factory.ts.
  const mode = env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock";
  const writes = env.GOOGLE_BUSINESS_WRITES?.trim() || "off";
  const badMode = mode !== "mock" && mode !== "live";
  const badWrites = mode === "live" && writes !== "off" && writes !== "live";
  const simulated = mode === "mock";
  const writesLive = mode === "live" && writes === "live";
  const modeDetail = 'Unrecognised value. Google calls fail until it is "mock" or "live".';
  const writesDetail = 'Unrecognised value. Google calls fail until it is "off" or "live".';
  const pubsubSet = Boolean(
    env.PUBSUB_TOPIC?.trim() && env.PUBSUB_AUDIENCE?.trim() && env.PUBSUB_SERVICE_ACCOUNT_EMAIL?.trim(),
  );
  const pubsubRow = pubsubStatus(pubsubSet, push);

  // Same rule as core's rankSource(): both DataForSEO keys set means real data; the sandbox host returns dummy data.
  const rankKeys = Boolean(env.DATAFORSEO_LOGIN?.trim() && env.DATAFORSEO_PASSWORD?.trim());
  const rankSandbox = rankKeys && env.DATAFORSEO_API_BASE?.trim() === "https://sandbox.dataforseo.com";
  const rankLive = rankKeys && !rankSandbox;

  const rows: LiveRow[] = [
    badMode
      ? {
          key: "google",
          label: "Google data",
          state: "misconfigured",
          detail: modeDetail,
          setting: "GOOGLE_BUSINESS_API_MODE",
        }
      : simulated
        ? {
            key: "google",
            label: "Google data",
            state: "simulated",
            detail:
              "Google is simulated on this server. Locations, reviews and posts are sample data.",
            setting: "GOOGLE_BUSINESS_API_MODE",
          }
        : {
            key: "google",
            label: "Google data",
            state: "live",
            detail:
              "Locations, reviews, profiles, photos, posts and performance are read from Google.",
            setting: "GOOGLE_BUSINESS_API_MODE",
          },
    {
      key: "writes",
      label: "Publishing to Google",
      state:
        badMode || badWrites
          ? "misconfigured"
          : simulated
            ? "simulated"
            : writesLive
              ? "live"
              : "off",
      detail: badMode
        ? modeDetail
        : badWrites
          ? writesDetail
          : simulated
            ? "Publishing goes to the simulator, not to Google."
            : writesLive
              ? "Replies, posts, profile edits and photos are sent to Google after approval."
              : "Replies, posts, profile edits and photos can be approved but are not sent.",
      setting: "GOOGLE_BUSINESS_WRITES",
    },
    // The worker consumes these values; web only reads them to display status.
    {
      key: "pubsub",
      label: "Instant review alerts",
      ...pubsubRow,
      setting: "PUBSUB_TOPIC, PUBSUB_AUDIENCE, PUBSUB_SERVICE_ACCOUNT_EMAIL",
    },
    {
      key: "rank",
      label: "Rank tracking",
      state: rankLive ? "live" : "sample",
      detail: rankLive
        ? "Heatmaps come from DataForSEO Google Maps."
        : rankSandbox
          ? "Heatmaps show DataForSEO sandbox data, which is made up, not real rankings."
          : "Heatmaps show sample data until DataForSEO is connected in Settings > Integrations.",
      setting: null,
    },
    {
      key: "email",
      label: "Email",
      state: emailOn ? "live" : "not_set_up",
      detail: emailOn
        ? "Digests, approval emails and monthly reports are sent."
        : "Digests, approval emails and monthly reports are not sent. Invitations show a link to copy.",
      setting: "RESEND_API_KEY, EMAIL_FROM",
    },
  ];

  const banner =
    badMode || badWrites
      ? "A Google setting on this server has an unrecognised value. Google calls fail until it is fixed."
      : simulated
        ? "Google is simulated here. Nothing reaches real Google profiles."
        : writesLive
          ? null
          : "Google writes are off. Nothing is published to Google yet.";

  // Sample data is labelled where it shows, so it does not count as a part that is not live.
  const notLive = rows.filter((r) => r.state !== "live" && r.state !== "sample").length;
  return { rows, notLive, banner };
}

function pubsubStatus(settingsSet: boolean, push?: PushFacts): { state: LiveState; detail: string } {
  if (!settingsSet) {
    return {
      state: "not_set_up",
      detail: "New reviews arrive when someone presses Sync. Google push is not connected.",
    };
  }
  if (!push || push.registered === 0) {
    return {
      state: "not_set_up",
      detail:
        "The settings are saved, but no Google account is registered yet. Press Apply to all connected accounts in Settings > Integrations.",
    };
  }
  const now = (push.now ?? new Date()).getTime();
  const flowing = push.lastPushAt !== null && now - push.lastPushAt.getTime() <= push.recentDays * 86_400_000;
  if (flowing) {
    return {
      state: "live",
      detail: "Google push is on. New reviews and suggested edits arrive without pressing Sync.",
    };
  }
  return {
    state: "off",
    detail: push.lastPushAt
      ? `No notification has arrived in the last ${push.recentDays} days. Google push may have stopped.`
      : "Waiting for first notification. Google accounts are registered; the first new or edited review will show here.",
  };
}
