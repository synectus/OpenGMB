import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { lockoutConfig } from "./limits/config";
import { WindowLimiter } from "./limits/window";

export type LockoutOptions = {
  /** Wrong passwords for one address inside the window before it is locked. */
  failures: number;
  windowMinutes: number;
  /** Test clock. */
  now?: () => number;
};

const SIGN_IN = "/sign-in/email";
const normalize = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");

/**
 * Per-account lockout (H1a), in addition to the per-IP limit (AUTH_RATE_LIMIT_RULES): a distributed
 * guess at one person's password stays under every single IP's limit but not this one. After
 * `failures` wrong passwords for an address the sign-in is refused (429, even with the right
 * password) until the window that started with the first failure ends. Time-based, never a
 * permanent lock, so an attacker can at worst slow a victim down by 15 minutes. Keyed by the
 * address whether or not an account exists, so the answer never says which accounts exist. State
 * is in process memory like the other limiters; a restart clears it.
 */
export function accountLockout(opts: LockoutOptions = lockoutConfig()): BetterAuthPlugin {
  const limiter = new WindowLimiter(opts.failures, opts.windowMinutes * 60_000, opts.now);
  return {
    id: "account-lockout",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const key = normalize((ctx.body as { email?: unknown } | undefined)?.email);
            const wait = key ? limiter.blockedFor(key) : 0;
            if (wait > 0) {
              throw new APIError(
                "TOO_MANY_REQUESTS",
                { message: "Too many failed sign-in attempts for this account. Try again later." },
                { "retry-after": String(wait) },
              );
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const key = normalize((ctx.body as { email?: unknown } | undefined)?.email);
            if (!key) return;
            const returned = ctx.context.returned;
            if (returned instanceof APIError) {
              // Only a wrong password counts; an unverified address (403) or a limit (429) does not.
              if (returned.statusCode === 401) limiter.hit(key);
            } else {
              limiter.reset(key);
            }
          }),
        },
      ],
    },
  };
}
