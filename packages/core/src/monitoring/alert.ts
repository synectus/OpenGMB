import { randomUUID } from "node:crypto";
import { alertEmail } from "../config/monitoring";
import { emailConfigured, emailFrom, escapeHtml, getEmailSender } from "../email";

export type AlertDelivery = "email" | "log";

/** Where an alert would go right now: an email only when ALERT_EMAIL and an email provider are both set. */
export function alertDelivery(): AlertDelivery {
  return alertEmail() && emailConfigured() ? "email" : "log";
}

/**
 * Sends one alert. Without ALERT_EMAIL or an email provider (dev, tests) it is written to the log as
 * `[alert] ...` instead. Never throws: a broken mailer must not take the thing being monitored down.
 */
export async function sendAlert(subject: string, text: string): Promise<AlertDelivery> {
  const to = alertEmail();
  const line = `[alert] ${subject} :: ${text.replace(/\s+/g, " ")}`;
  if (!to || !emailConfigured()) {
    console.log(line);
    return "log";
  }
  try {
    await getEmailSender()({
      from: emailFrom(),
      to,
      subject: `[SynGMB] ${subject}`,
      text,
      html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
      idempotencyKey: randomUUID(),
    });
    return "email";
  } catch (e) {
    console.error(`[alert] email failed (${e instanceof Error ? e.message : "unknown"}); ${line}`);
    return "log";
  }
}
