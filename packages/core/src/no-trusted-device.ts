import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

// SynGMB requires TOTP on every sign-in. Better-Auth's twoFactor verify endpoints accept
// `trustDevice: true`, which sets a signed cookie that lets the device skip the challenge
// for 30 days (plugins/two-factor/verify-two-factor.mjs). twoFactor has no option to turn
// that off, so this plugin rejects any request that asks for it; the trust cookie is
// therefore never issued and the after-hook that honours it never finds one.
const VERIFY_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);

export function noTrustedDevice(): BetterAuthPlugin {
  return {
    id: "no-trusted-device",
    hooks: {
      before: [
        {
          matcher: (ctx) => !!ctx.path && VERIFY_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { trustDevice?: unknown } | undefined;
            if (body && body.trustDevice !== undefined && body.trustDevice !== false) {
              throw new APIError("BAD_REQUEST", {
                message: "Trusted devices are not supported; TOTP is required on every sign-in",
              });
            }
          }),
        },
      ],
    },
  };
}
