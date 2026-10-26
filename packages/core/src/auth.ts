import { signupPerIpPerHour } from "./config/platform-limits";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import { and, eq, isNotNull } from "drizzle-orm";
import { accountLockout, type LockoutOptions } from "./account-lockout";
import { BLOCKED_MESSAGES, blockedReason } from "./account-state";
import { noTrustedDevice } from "./no-trusted-device";
import { sendVerificationLink } from "./verification-email";
import {
  RESET_TOKEN_EXPIRES_SECONDS,
  auditPasswordResetCompleted,
  passwordResetLimit,
  sendPasswordResetEmail,
} from "./password-reset";
import { trustedCustomOrigins } from "./custom-domains";
import { provisionAccount, signupEnabled } from "./signup";
import { socialSignInMfaChallenge } from "./social-mfa";
import { magicLinkPlugins } from "./magic-link";
import {
  accounts,
  sessions,
  twoFactors,
  users,
  verifications,
  type Db,
  type Tx,
} from "@opengmb/db";

// ---------------------------------------------------------------------------
// Session timeout policy (single source of truth).
//  - Idle timeout: a session expires 2h after its last refresh. Better-Auth
//    pushes `expiresAt` forward at most once per UPDATE_AGE while the user is
//    active, so an active session slides and an idle one dies after ~2h.
//  - Absolute cap: 12h from `sessions.created_at`, regardless of activity.
//    Better-Auth has no such option; it is enforced by requireAuthenticatedUser
//    (session.ts), the single check every later layer must call.
// ---------------------------------------------------------------------------
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 5 * 60;
export const SESSION_ABSOLUTE_MAX_SECONDS = 12 * 60 * 60;

export const TOTP_ISSUER = "OpenGMB";

/** Backup codes per set. Passed to the twoFactor plugin; the Account page shows "N of this left". */
export const BACKUP_CODE_COUNT = 10;

/**
 * Per-IP limits on the auth endpoints (Better-Auth's own limiter, in-process memory, one bucket per
 * IP and path). They replace Better-Auth's defaults for these paths, which are 3 sign-ins per 10 s
 * and nothing specific for the second factor, so TOTP and backup codes fell under the general
 * 100 requests per 10 s. Everything else keeps the general default.
 */
export const AUTH_RATE_LIMIT_RULES = {
  "/sign-in/*": { window: 60, max: 10 },
  // OPS1: per IP per hour (was 10 a minute); AUTH_SIGNUP_PER_IP_PER_HOUR changes it.
  "/sign-up/*": { window: 3600, max: signupPerIpPerHour() },
  "/two-factor/*": { window: 60, max: 8 },
  // Password reset sends mail; the per-address limit (5 an hour) is in passwordResetLimit().
  "/request-password-reset": { window: 3600, max: 10 },
} as const;

export interface AuthOptions {
  /** Defaults to on in production and off elsewhere (tests and e2e sign in many times from one IP). */
  rateLimitEnabled?: boolean;
  secret?: string;
  baseURL?: string;
  /** Better-Auth skips its Origin check under NODE_ENV=test; a test sets this to see the production check. */
  enforceOriginCheck?: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  /**
   * Unverified email addresses cannot sign in and sign-up creates no session until the emailed
   * link is opened. Defaults to on in production and off elsewhere (tests and e2e sign up and use
   * the account at once); REQUIRE_EMAIL_VERIFICATION=true|false overrides the default.
   */
  requireEmailVerification?: boolean;
  /** Per-account lockout; defaults to lockoutConfig() (AUTH_LOCKOUT_FAILURES / AUTH_LOCKOUT_MINUTES). */
  lockout?: LockoutOptions;
  /** Extra Better-Auth plugins, e.g. nextCookies() on the web instance. */
  plugins?: BetterAuthPlugin[];
  /**
   * Test-only: runs inside the sign-up transaction after the organization, membership and audit
   * rows are inserted. Throwing here must roll back the user, account and session as well.
   */
  onProvisionOrganization?: (tx: Tx, userId: string) => Promise<void>;
}

/** The Drizzle transaction Better-Auth is currently running its adapter calls in. */
const txStorage = new AsyncLocalStorage<Tx>();

/** Email verification is required in production unless REQUIRE_EMAIL_VERIFICATION says otherwise. */
export function isEmailVerificationRequired(
  env: string | undefined = process.env.REQUIRE_EMAIL_VERIFICATION,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const v = env?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return nodeEnv === "production";
}

/** Google sign-in is offered only when both credentials are non-empty. */
export function isGoogleConfigured(
  clientId: string | undefined = process.env.GOOGLE_CLIENT_ID,
  clientSecret: string | undefined = process.env.GOOGLE_CLIENT_SECRET,
): boolean {
  return Boolean(clientId?.trim() && clientSecret?.trim());
}

export function createAuth(db: Db, opts: AuthOptions = {}) {
  const clientId = opts.googleClientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = opts.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET;

  // Better-Auth runs the adapter inside `db.transaction(tx => ...)` but never exposes `tx`.
  // Re-publish it through AsyncLocalStorage so our hook inserts on the same connection.
  const txCapturingDb: Db = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return (cb: (tx: Tx) => Promise<unknown>, config?: unknown) =>
          (target.transaction as (cb: unknown, config?: unknown) => Promise<unknown>)(
            (tx: Tx) => txStorage.run(tx, () => cb(tx)),
            config,
          );
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const requireEmailVerification = opts.requireEmailVerification ?? isEmailVerificationRequired();

  return betterAuth({
    secret: opts.secret ?? process.env.BETTER_AUTH_SECRET,
    baseURL: opts.baseURL ?? process.env.BETTER_AUTH_URL,
    // G3: the origins of active custom hosts on top of baseURL. baseURL stays static.
    // A failed read trusts no custom host (baseURL still works): sign-in on the main host must not depend on it.
    trustedOrigins: async () => {
      try {
        return await trustedCustomOrigins(db, opts.baseURL ?? process.env.BETTER_AUTH_URL);
      } catch (e) {
        console.error("[auth] could not read custom hosts", e instanceof Error ? e.message : e);
        return [];
      }
    },
    ...(opts.enforceOriginCheck ? { advanced: { disableOriginCheck: false } } : {}),
    // usePlural maps model "user" -> schema.users, "twoFactor" -> schema.twoFactors, etc.
    // The schema is passed explicitly so only the five Better-Auth tables are visible to it.
    database: drizzleAdapter(txCapturingDb, {
      provider: "pg",
      // Wrap every request that creates a user in one DB transaction; see txStorage.
      transaction: true,
      usePlural: true,
      schema: {
        users,
        sessions,
        accounts,
        verifications,
        twoFactors,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !signupEnabled(),
      requireEmailVerification,
      sendResetPassword: async ({ user, token }) => {
        sendPasswordResetEmail(db, user, token, opts.baseURL);
      },
      resetPasswordTokenExpiresIn: RESET_TOKEN_EXPIRES_SECONDS,
      // The person resetting may be doing it because someone else has a session.
      revokeSessionsOnPasswordReset: true,
      // Two-factor is untouched: the next sign-in still needs a code.
      onPasswordReset: async ({ user }) => {
        await auditPasswordResetCompleted(db, user.id);
      },
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      // A correct password from an unverified address sends a fresh link (the first one may have
      // expired or only ever reached a log), so a lost link never strands the account.
      sendOnSignIn: requireEmailVerification,
      // The person signs in themselves after confirming, so two-factor setup is never skipped.
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationLink(db, user, url);
      },
    },
    rateLimit: {
      enabled: opts.rateLimitEnabled ?? process.env.NODE_ENV === "production",
      customRules: { ...AUTH_RATE_LIMIT_RULES },
    },
    databaseHooks: {
      // AP3b: every sign-in path (password, 2FA step, Google, magic link) creates a session, so this one check
      // refuses a suspended or deleted account and a user whose sign-in was turned off. A stand-in in the community
      // edition never refuses. It reads inside Better-Auth's own transaction when there is one (a brand-new user is
      // not visible to the pool yet).
      session: {
        create: {
          before: async (session) => {
            const reason = await blockedReason(txStorage.getStore() ?? db, session.userId);
            // Not 403 (the sign-in form reads that as "confirm your email") and not 401 (the lockout counts it as a wrong password).
            if (reason) throw new APIError("BAD_REQUEST", { message: BLOCKED_MESSAGES[reason] });
          },
        },
      },
      account: {
        create: {
          // Runs INSIDE Better-Auth's sign-up / OAuth transaction (the user row is already inserted
          // there, and it rolls back with it). `user.create.after` cannot be used: Better-Auth
          // queues it until after commit. Every user-creating path inserts an account right after
          // the user, so this is where a new user's organization is provisioned.
          before: async (account, context) => {
            const tx = txStorage.getStore();
            if (!tx) throw new Error("account created outside a Better-Auth transaction");
            await provisionAccount(
              tx,
              account.userId,
              context?.headers?.get("cookie"),
              opts.onProvisionOrganization,
            );
          },
        },
      },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    ...(isGoogleConfigured(clientId, clientSecret)
      ? { socialProviders: { google: { clientId: clientId!, clientSecret: clientSecret! } } }
      : {}),
    plugins: [
      // allowPasswordless: users without a credential password (Google-only) can enable
      // 2FA without one. If a credential account with a password exists, it is still required.
      twoFactor({
        issuer: TOTP_ISSUER,
        allowPasswordless: true,
        // Only `amount` is set; the plugin keeps its default storeBackupCodes: "encrypted".
        backupCodeOptions: { amount: BACKUP_CODE_COUNT },
      }),
      // twoFactor does not challenge OAuth sign-ins; see social-mfa.ts.
      socialSignInMfaChallenge(),
      // MFA is mandatory on every sign-in; refuse trustDevice; see no-trusted-device.ts.
      noTrustedDevice(),
      // Per-account sign-in lockout on top of the per-IP limit; see account-lockout.ts.
      accountLockout(opts.lockout, db),
      passwordResetLimit(),
      // Client users can sign in with an emailed link; MFA still applies (see social-mfa.ts).
      ...magicLinkPlugins(db, opts.baseURL),
      ...(opts.plugins ?? []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** True when the user has a credential (email+password) account; Google-only users do not. */
export async function hasCredentialPassword(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, "credential"),
        isNotNull(accounts.password),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * How many unused backup codes the user has. viewBackupCodes is server-only and returns the
 * decrypted codes, so only the count leaves this function. Throws if the user has no two-factor
 * row (callers run after requireAuthenticatedUser, which guarantees one).
 */
export async function countBackupCodes(auth: Auth, userId: string): Promise<number> {
  const out = await auth.api.viewBackupCodes({ body: { userId } });
  return out.backupCodes.length;
}
