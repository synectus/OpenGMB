import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Db } from "@opengmb/db";
import { OAUTH_SCOPES, type OAuthAddresses } from "./addresses";
import { consentReference, hasOrgChoice } from "./org-choice";
import { normaliseRegistration, RegistrationError } from "./registration";

/** Hosts the consent page does not warn about. A hint against look-alike apps, not a gate (spec, Security). */
export const KNOWN_CLIENT_HOSTS = ["claude.ai", "chatgpt.com", "localhost", "127.0.0.1", "[::1]"] as const;

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** Open registration: 10 per hour per IP (spec, Security). Better-Auth's limiter, on in production. */
export const REGISTER_RATE_LIMIT = { window: 3600, max: 10 } as const;

/** Postgres 23505 anywhere in a Drizzle error's cause chain (Drizzle wraps it; the wrapper's message does not say "duplicate"). */
function isUniqueViolation(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 5; i++, c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

export function oauthPlugins(db: Db, addresses: OAuthAddresses) {
  const provider = oauthProvider({
    loginPage: "/sign-in",
    consentPage: "/oauth/consent",
    scopes: [...OAUTH_SCOPES],
    clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
    resources: [addresses.resource],
    clientRegistrationDefaultResources: [addresses.resource],
    rateLimit: { register: { ...REGISTER_RATE_LIMIT } },
    postLogin: {
      // The account is chosen on the consent page (see org-choice.ts), so this step never redirects.
      page: "/oauth/consent",
      shouldRedirect: () => false,
      consentReferenceId: ({ user, session }) => consentReference(db, { userId: user.id, sessionId: session.id }),
    },
    // The MCP container finds the connection's api_tokens row by (sub, client_id, org_id).
    customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org_id: referenceId } : {}),
  });
  const seedingInit = provider.init;
  return [
    // issuer must equal BETTER_AUTH_URL: the default includes /api/auth and would not match the metadata.
    // No JWT header on get-session: nothing in the app uses session JWTs, and /token is disabled.
    jwt({ jwt: { issuer: addresses.issuer }, disableSettingJwtHeader: true }),
    {
      ...provider,
      // The plugin seeds oauth_resources in init and ignores a concurrent insert only when the error MESSAGE says
      // "duplicate"; Drizzle's wrapper says "Failed query", so two processes (or two test files) starting at once
      // crashed one with oauth_resources_identifier_unique (spike, 2026-11-10). Retrying once finds the row and skips the insert.
      init: async (ctx: Parameters<NonNullable<typeof seedingInit>>[0]) => {
        try {
          return await seedingInit!(ctx);
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          return await seedingInit!(ctx);
        }
      },
    },
  ];
}

/**
 * Every plugin endpoint reachable over HTTP, in exactly one of two lists (Phase 0 spike, 2026-11-10, better-auth and
 * @better-auth/oauth-provider 1.7.7; flow.test.ts checks both lists against the installed plugins).
 * Used: the product calls these. /oauth2/register is also in REDIRECT_URI_PATHS (guarded).
 */
export const OAUTH_USED_PATHS: string[] = [
  "/oauth2/authorize",
  "/oauth2/token",
  "/oauth2/register",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/revoke",
  "/jwks",
];

/**
 * Plugin endpoints the product does not use, turned off at the router (404). disabledPaths is an exact string match on
 * the request path, so a path with a :param cannot be listed; the plugin's own :param endpoints (admin resources) are
 * SERVER_ONLY and have no HTTP route at all (OAUTH_SERVER_ONLY_PATHS, checked in flow.test.ts).
 */
export const OAUTH_DISABLED_PATHS: string[] = [
  "/token",
  "/oauth2/introspect",
  "/oauth2/userinfo",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
];

/** Plugin endpoints marked SERVER_ONLY: no HTTP route, reachable only through auth.api in our own code. */
export const OAUTH_SERVER_ONLY_PATHS: string[] = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier",
  "/admin/oauth2/resources/:identifier/clients/:client_id",
];

/** Every remaining endpoint that can set redirect_uris (library fact 9): the register route, plus any guarded path from Step 0. */
export const REDIRECT_URI_PATHS = new Set<string>(["/oauth2/register"]);

/**
 * Better-Auth hooks.before.
 * 1. Our redirect URI rules on every endpoint in REDIRECT_URI_PATHS.
 * 2. /oauth2/consent with accept: true is refused unless our consent action stored an account choice for the session, for
 *    every user, one organization or many. The action always stores one (rememberOrgChoice), so a direct POST that skips
 *    our page is refused, and a consent can never be stored under the "unchosen" sentinel.
 */
export function oauthBeforeHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/oauth2/consent") {
      if ((ctx.body as { accept?: boolean } | undefined)?.accept !== true) return;
      const session = await getSessionFromCtx(ctx);
      if (!session || !(await hasOrgChoice(db, session.session.id))) {
        throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "Choose an account on the consent page first" });
      }
      return;
    }
    if (!REDIRECT_URI_PATHS.has(ctx.path) || !ctx.body) return;
    try {
      return { context: { body: normaliseRegistration(ctx.body as Record<string, unknown>) } };
    } catch (e) {
      if (e instanceof RegistrationError) {
        throw new APIError("BAD_REQUEST", { error: "invalid_redirect_uri", error_description: e.message });
      }
      throw e;
    }
  });
}
