import { createHash } from "node:crypto";
import type { Db } from "@opengmb/db";
import { emailFromForUser, originForUser } from "./custom-domains";
import { emailConfigured, getEmailSender, renderBrandedEmail } from "./email";

/**
 * The sign-up verification mail, sent through the same SendEmail abstraction as every other mail
 * (Resend once RESEND_API_KEY and EMAIL_FROM are set, the mock before). Until a provider is set up
 * nothing leaves the system, so the link is logged for the operator to open; the log line is the
 * only place the link appears.
 */
export async function sendVerificationLink(db: Db, user: { id: string; email: string; name: string }, rawUrl: string) {
  // A client of an agency with its own address confirms on that address: only the origin changes, the token path does not.
  const given = new URL(rawUrl);
  const origin = await originForUser(db, user.id, given.origin);
  const url = origin === given.origin ? rawUrl : `${origin}${given.pathname}${given.search}${given.hash}`;
  if (!emailConfigured()) {
    console.log(`[email:mock] verification link for ${user.email}: ${url}`);
  }
  const { html, text } = renderBrandedEmail(
    { agencyName: "OpenGMB", logoUrl: null, primaryColor: null },
    {
      heading: "Confirm your email address",
      paragraphs: [
        `Hi ${user.name}, confirm this address to finish creating your OpenGMB account.`,
        "If you did not sign up, you can ignore this email.",
      ],
      cta: { label: "Confirm email", url },
    },
  );
  await getEmailSender()({
    from: await emailFromForUser(db, user.id),
    to: user.email,
    subject: "Confirm your OpenGMB email address",
    html,
    text,
    idempotencyKey: `verify-email-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`,
  });
}
