import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";

// Better-Auth 1.7.7's twoFactor plugin only challenges /sign-in/email|username|phone-number
// (plugins/two-factor/index.mjs, after-hook matcher). A session created by an OAuth callback
// (Google), by /magic-link/verify or by /sign-in/social with an idToken is returned as fully authenticated even when
// user.twoFactorEnabled is true. This plugin closes that gap by mirroring the twoFactor
// plugin's own challenge for those paths: discard the fresh session, set the signed
// `two_factor` challenge cookie, and send the user to the TOTP page. verify-totp then
// completes the sign-in exactly as it does for email+password.
const TWO_FACTOR_COOKIE_NAME = "two_factor"; // plugins/two-factor/constant.mjs (not exported)
const CHALLENGE_MAX_AGE_SECONDS = 600; // twoFactor plugin default (twoFactorCookieMaxAge)

const isSocialSessionPath = (path: string | undefined) =>
  !!path &&
  (path === "/sign-in/social" ||
    path === "/magic-link/verify" ||
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2/callback/"));

export function socialSignInMfaChallenge(mfaVerifyPath = "/mfa/verify"): BetterAuthPlugin {
  return {
    id: "social-sign-in-mfa-challenge",
    hooks: {
      after: [
        {
          matcher: (ctx) => isSocialSessionPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession;
            if (!data?.user.twoFactorEnabled) return;

            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(data.session.token);
            ctx.context.setNewSession(null);

            const expiresAt = new Date(Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000);
            const identifier = `2fa-${generateRandomString(20)}`;
            await ctx.context.internalAdapter.createVerificationValue({
              value: data.user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
              maxAge: CHALLENGE_MAX_AGE_SECONDS,
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );

            if (ctx.path === "/sign-in/social") {
              return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
            }
            throw ctx.redirect(mfaVerifyPath);
          }),
        },
      ],
    },
  };
}
