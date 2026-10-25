/**
 * How Google names this app on its consent screen and on myaccount.google.com/permissions. Not ours
 * to choose here: it is the Google Auth Platform branding of your own Google Cloud project, and changing
 * it restarts Google's branding review. Strings that send people to Google's screens read this value.
 *
 * Set GOOGLE_OAUTH_BRAND_APP_NAME to the app name your Cloud project's consent screen shows, and
 * optionally GOOGLE_OAUTH_BRAND_SOURCE_URL to that project's branding page (https). Leave them unset
 * if your consent screen uses the default name below.
 */
const appName = process.env.GOOGLE_OAUTH_BRAND_APP_NAME?.trim() || "OpenGMB";
const sourceUrl = process.env.GOOGLE_OAUTH_BRAND_SOURCE_URL?.trim() || "https://console.cloud.google.com/auth/branding";

export const GOOGLE_OAUTH_BRAND = {
  appName: {
    value: appName,
    sourceUrl,
    verifiedOn: "2026-10-22",
    status: "verified" as const,
    note: "The app name on your Google Cloud project's consent screen. Set GOOGLE_OAUTH_BRAND_APP_NAME if it is not the default.",
  },
} as const;
