// Pure helpers for /settings/google. No core runtime import: the scope string is pinned by a test.

/** core's BUSINESS_MANAGE_SCOPE (packages/core/src/google/oauth.ts); google-connection.test.ts checks it. */
export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** core's GOOGLE_OAUTH_BRAND.appName (google-connection.test.ts checks it): the name Google's screens show. Server-only: reads the same env var. */
export const GOOGLE_APP_NAME = process.env.GOOGLE_OAUTH_BRAND_APP_NAME?.trim() || "OpenGMB";

/** `?error=<code>` from app/api/google/callback/route.ts, in plain language. */
const ERRORS: Record<string, string> = {
  missing_scope: "Tick the Business Profile box on Google’s consent screen, then try again.",
  access_denied: "You cancelled on Google’s screen.",
  invalid_state: "The sign-in took too long or came from another tab. Try again.",
  missing_refresh_token: `Google did not give lasting access. Remove ${GOOGLE_APP_NAME} from your Google account’s third-party access, then connect again.`,
  exchange_failed: "Google did not answer. Try again in a minute.",
  userinfo_failed: "Google did not answer. Try again in a minute.",
  not_configured: "Google OAuth is not configured on this server.",
  forbidden: "You do not have permission to connect Google accounts.",
};

export function googleCallbackError(code: string): { code: string; text: string } {
  return { code, text: ERRORS[code] ?? "Could not connect Google. Try again." };
}

const SCOPE_LABEL: Record<string, string | null> = {
  [BUSINESS_SCOPE]: "Business Profile",
  email: "Email address",
  "https://www.googleapis.com/auth/userinfo.email": "Email address",
  openid: null, // sign-in identity only, not a permission worth showing
};

/** Granted scopes as readable labels, de-duplicated, business scope first. */
export function scopeLabels(scopes: string[]): string {
  const labels = scopes
    .map((s) => (s in SCOPE_LABEL ? SCOPE_LABEL[s] : s))
    .filter((l): l is string => l !== null);
  const unique = [...new Set(labels)].sort((a, b) =>
    a === "Business Profile" ? -1 : b === "Business Profile" ? 1 : 0,
  );
  return unique.length > 0 ? unique.join(", ") : "None";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 Google account · 6 locations imported", plus the relink count when there is one. */
export function connectionSummary(
  accounts: number,
  locations: { googleLocationId: string | null; needsRelink: boolean }[],
): string {
  const imported = locations.filter((l) => l.googleLocationId !== null).length;
  const relink = locations.filter((l) => l.needsRelink).length;
  const parts = [
    plural(accounts, "Google account", "Google accounts"),
    `${plural(imported, "location", "locations")} imported`,
  ];
  if (relink > 0) parts.push(`${relink} not linked to Google`);
  return parts.join(" · ");
}
