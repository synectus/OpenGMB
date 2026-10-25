import { getIntegration } from "./integrations";
import { reportLimitEvent } from "./limits/alerts";

export type EmailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /** Extra mail headers, e.g. List-Unsubscribe. Resend accepts a `headers` object. */
  headers?: Record<string, string>;
  /** Inline images, referenced in the html as `cid:<contentId>`. `content` is base64. */
  attachments?: { filename: string; content: string; contentType: string; contentId: string }[];
};
export type SendEmail = (msg: EmailMessage) => Promise<void>;

/** Resend REST API: https://resend.com/docs/api-reference/emails/send-email */
export function resendSendEmail(apiKey: string): SendEmail {
  return async (msg) => {
    const { idempotencyKey, attachments, ...rest } = msg;
    const body = {
      ...rest,
      ...(attachments
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              content_type: a.contentType,
              content_id: a.contentId,
            })),
          }
        : {}),
    };
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }).catch((e: unknown) => {
      reportLimitEvent("email_failed");
      throw e;
    });
    if (!res.ok) {
      reportLimitEvent("email_failed");
      throw new Error(`Resend responded ${res.status}`);
    }
  };
}

/** Dev/CI sender when no provider is configured: records that a mail would go out, never its body. */
export const mockSendEmail: SendEmail = async (msg) => {
  console.log(`[email:mock] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
};

let override: { send: SendEmail; configured: boolean } | null = null;

/** Tests inject a fake sender (and whether it counts as a configured provider). null restores env. */
export function setEmailSender(send: SendEmail | null, configured = true): void {
  override = send ? { send, configured } : null;
}

/** True when mail really leaves the system: both RESEND_API_KEY and EMAIL_FROM are set (environment or in-app). */
export function emailConfigured(): boolean {
  if (override) return override.configured;
  return Boolean(getIntegration("RESEND_API_KEY") && getIntegration("EMAIL_FROM"));
}

export function emailFrom(): string {
  return getIntegration("EMAIL_FROM") || "OpenGMB <noreply@localhost.invalid>";
}

/** The sender actions use: the injected fake, Resend when configured, otherwise the mock. */
export function getEmailSender(): SendEmail {
  if (override) return override.send;
  const key = getIntegration("RESEND_API_KEY");
  return emailConfigured() && key ? resendSendEmail(key) : mockSendEmail;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What emails need from an organization's branding (already validated on write). */
export type EmailBrand = {
  agencyName: string;
  logoUrl: string | null;
  primaryColor: string | null;
};

const HEX = /^#[0-9a-f]{6}$/;

/** A small branded HTML + text email. Every dynamic value is escaped; colours are re-validated. */
export function renderBrandedEmail(
  brand: EmailBrand,
  content: { heading: string; paragraphs: string[]; cta?: { label: string; url: string } },
) {
  const color = brand.primaryColor && HEX.test(brand.primaryColor) ? brand.primaryColor : "#111111";
  const logo =
    brand.logoUrl && brand.logoUrl.startsWith("https://")
      ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.agencyName)}" height="40" style="display:block;margin-bottom:12px">`
      : "";
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    logo +
    `<h2 style="color:${color};margin:0 0 12px">${escapeHtml(content.heading)}</h2>` +
    content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    (content.cta
      ? `<p><a href="${escapeHtml(content.cta.url)}" style="display:inline-block;background:${color};color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none">${escapeHtml(content.cta.label)}</a></p>` +
        `<p style="font-size:12px;color:#555">If the button does not work, open ${escapeHtml(content.cta.url)}</p>`
      : "") +
    `<p style="font-size:12px;color:#555">${escapeHtml(brand.agencyName)}</p></div>`;
  const text = [
    content.heading,
    "",
    ...content.paragraphs,
    ...(content.cta ? ["", `${content.cta.label}: ${content.cta.url}`] : []),
    "",
    brand.agencyName,
  ].join("\n");
  return { html, text };
}
