import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { memberships, type Db } from "@opengmb/db";
import { writeAudit } from "./audit";
import { emailFromForUser, originForUser } from "./custom-domains";
import { emailConfigured, getEmailSender, renderBrandedEmail } from "./email";
import { WindowLimiter } from "./limits/window";

/** A reset link is good for 30 minutes and for one use. */
export const RESET_TOKEN_EXPIRES_SECONDS = 30 * 60;

/** Reset requests per address per hour (the per-IP limit is in AUTH_RATE_LIMIT_RULES). */
export const RESET_REQUESTS_PER_EMAIL_PER_HOUR = 5;

const REQUEST_PATH = "/request-password-reset";
const normalize = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");

/**
 * Per-address limit on reset requests, keyed by the address whether or not an account exists so a
 * 429 never says which accounts exist. Every request counts, so repeating one address cannot be
 * used to flood a person's inbox. In process memory like the other limiters.
 */
export function passwordResetLimit(now?: () => number): BetterAuthPlugin {
  const limiter = new WindowLimiter(RESET_REQUESTS_PER_EMAIL_PER_HOUR, 60 * 60_000, now);
  return {
    id: "password-reset-limit",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === REQUEST_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const key = normalize((ctx.body as { email?: unknown } | undefined)?.email);
            if (!key) return;
            const wait = limiter.hit(key);
            if (wait > 0) {
              throw new APIError(
                "TOO_MANY_REQUESTS",
                { message: "Too many reset requests for this address. Try again later." },
                { "retry-after": String(wait) },
              );
            }
          }),
        },
      ],
    },
  };
}

/** One audit row per organization the user belongs to; user id only, never the address or token. */
async function auditReset(
  db: Db,
  userId: string,
  action: "auth.password_reset_requested" | "auth.password_reset_completed",
) {
  const orgs = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  for (const { orgId } of orgs) {
    await db.transaction((tx) =>
      writeAudit(tx, {
        orgId,
        actorUserId: action === "auth.password_reset_completed" ? userId : null,
        actorType: action === "auth.password_reset_completed" ? "user" : "system",
        surface: "ui",
        action,
        entityType: "user",
        entityId: userId,
      }),
    );
  }
}

/** Runs before Better-Auth revokes sessions, so a failed audit write must not abort the reset. */
export async function auditPasswordResetCompleted(db: Db, userId: string) {
  try {
    await auditReset(db, userId, "auth.password_reset_completed");
  } catch (e) {
    console.error(`[password-reset] audit failed for user ${userId}: ${(e as Error).message}`);
  }
}

/**
 * Better-Auth's sendResetPassword. It starts the send and returns at once, and never throws: an
 * await (or a failing provider) would make an address with an account answer slower, or with a
 * 500, than one without, which tells a visitor which addresses are registered. Failures are logged
 * without the address.
 */
export function sendPasswordResetEmail(
  db: Db,
  user: { id: string; email: string; name: string },
  token: string,
  baseURL: string | undefined,
) {
  const base = (baseURL ?? process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  void (async () => {
    try {
      // A client of an agency with its own address gets the link and the sender of that agency.
      const url = `${await originForUser(db, user.id, base)}/reset-password?token=${encodeURIComponent(token)}`;
      if (!emailConfigured()) {
        console.log(`[email:mock] password reset link for ${user.email}: ${url}`);
      }
      const { html, text } = renderBrandedEmail(
        { agencyName: "OpenGMB", logoUrl: null, primaryColor: null },
        {
          heading: "Reset your password",
          paragraphs: [
            `Hi ${user.name}, use the button below to choose a new password. The link works once and expires in 30 minutes.`,
            "If you did not ask for this, you can ignore this email. Your password stays as it is.",
          ],
          cta: { label: "Choose a new password", url },
        },
      );
      await getEmailSender()({
        from: await emailFromForUser(db, user.id),
        to: user.email,
        subject: "Reset your OpenGMB password",
        html,
        text,
        idempotencyKey: `reset-password-${createHash("sha256").update(token).digest("hex").slice(0, 32)}`,
      });
      await auditReset(db, user.id, "auth.password_reset_requested");
    } catch (e) {
      console.error(`[password-reset] send failed for user ${user.id}: ${(e as Error).message}`);
    }
  })();
}
