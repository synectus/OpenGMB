import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { memberships, users, type Db } from "@opengmb/db";
import { loadBranding } from "./branding";
import { emailFromForUser, originForUser } from "./custom-domains";
import { emailConfigured, getEmailSender, renderBrandedEmail } from "./email";
import { isClientRole } from "./client-role";
import { WindowLimiter } from "./limits/window";

/** A sign-in link is good for 10 minutes and for one use. */
export const MAGIC_LINK_EXPIRES_SECONDS = 10 * 60;

/** Link requests per address per hour (the per-IP limit is Better-Auth's own rate rule). */
export const MAGIC_LINK_REQUESTS_PER_EMAIL_PER_HOUR = 5;

const REQUEST_PATH = "/sign-in/magic-link";
const normalize = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");

/** Same shape as passwordResetLimit: keyed by address whether or not an account exists. */
function magicLinkLimit(now?: () => number): BetterAuthPlugin {
  const limiter = new WindowLimiter(MAGIC_LINK_REQUESTS_PER_EMAIL_PER_HOUR, 60 * 60_000, now);
  return {
    id: "magic-link-limit",
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
                { message: "Too many sign-in link requests for this address. Try again later." },
                { "retry-after": String(wait) },
              );
            }
          }),
        },
      ],
    },
  };
}

/**
 * Sends the link only to a user whose every membership is a client role (a client approver or
 * viewer). Staff, unknown addresses and everyone else get no mail and the same answer, so the
 * response never says which addresses have an account. Failures are logged without the address.
 */
async function sendLink(db: Db, email: string, rawUrl: string, baseURL: string | undefined) {
  try {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!user) return;
    const ms = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    if (ms.length === 0 || ms.some((m) => !isClientRole(m.role))) return;
    const given = new URL(rawUrl);
    const origin = await originForUser(db, user.id, baseURL ?? given.origin);
    const url = `${origin}${given.pathname}${given.search}`;
    if (!emailConfigured()) {
      console.log(`[email:mock] sign-in link for ${user.email}: ${url}`);
    }
    const brand = await loadBranding(db, ms[0]!.orgId);
    const { html, text } = renderBrandedEmail(brand, {
      heading: `Sign in to ${brand.agencyName}`,
      paragraphs: [
        `Hi ${user.name}, use the button below to sign in. The link works once and expires in 10 minutes.`,
        "You will be asked for your two-factor code. If you did not ask for this, you can ignore this email.",
      ],
      cta: { label: "Sign in", url },
    });
    await getEmailSender()({
      from: await emailFromForUser(db, user.id),
      to: user.email,
      subject: `Your sign-in link for ${brand.agencyName}`,
      html,
      text,
      idempotencyKey: `magic-link-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`,
    });
  } catch (e) {
    console.error(`[magic-link] send failed: ${(e as Error).message}`);
  }
}

/** Passwordless sign-in for client users. Never creates an account (disableSignUp). */
export function magicLinkPlugins(db: Db, baseURL: string | undefined): BetterAuthPlugin[] {
  return [
    magicLink({
      expiresIn: MAGIC_LINK_EXPIRES_SECONDS,
      disableSignUp: true,
      storeToken: "hashed",
      // Started and not awaited: an await would make a client address answer slower than an unknown one.
      sendMagicLink: async ({ email, url }) => {
        void sendLink(db, email, url, baseURL ?? process.env.BETTER_AUTH_URL);
      },
    }),
    magicLinkLimit(),
  ];
}
