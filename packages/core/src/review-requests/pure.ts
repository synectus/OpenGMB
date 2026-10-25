import { randomBytes } from "node:crypto";
import { MAX_RECIPIENTS_PER_IMPORT, SEND_FROM_HOUR, SEND_UNTIL_HOUR } from "../config/review-requests";
import { parseCsv } from "../posts/bulk/csv";
import { localParts } from "../time";
import { escapeHtml, renderBrandedEmail, type EmailBrand } from "../email";
import { OPERATOR_LEGAL_ENTITY, OPERATOR_REGISTERED_OFFICE } from "../config/operator";
import type { SenderIdentity } from "./identity";

export const DEFAULT_SUBJECT = "Could you leave {business} a Google review?";
export const DEFAULT_BODY =
  "Hi {name},\n\nThank you for choosing {business}. If you have a minute, we would be grateful if you left us a review on Google.\n\nThank you.";

const EMAIL_RE = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const isValidEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);

export const newToken = () => randomBytes(32).toString("base64url");
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Google forbids review gating and asking for ratings. The email may only ask for a review, so
 * wording that asks for stars, a score, a survey or "how was your visit" is refused.
 */
const GATING = /(\bstars?\b|★|\brat(?:e|ing|ings)\b|\bscore\b|\bsurvey\b|\bfeedback\b|\bout of (?:5|five|10|ten)\b|\bhow (?:was|did|were)\b|\bhow we did\b|\bhappy with\b|\bsatisf)/i;
export function gatingProblem(text: string): string | null {
  const m = GATING.exec(text);
  return m ? `Remove "${m[0]}": the email may only ask for a Google review, never for a rating, a score, a survey or how the visit went.` : null;
}

export type ParsedRecipients = {
  rows: { email: string; name: string | null }[];
  invalid: number;
  duplicates: number;
};

/** Lower-cases, validates and de-duplicates addresses. */
export function cleanRecipients(input: { email: string; name?: string | null }[]): ParsedRecipients {
  const seen = new Set<string>();
  const rows: ParsedRecipients["rows"] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const r of input) {
    const email = normalizeEmail(r.email);
    if (!isValidEmail(email)) {
      invalid++;
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    const name = r.name?.trim().slice(0, 100) || null;
    rows.push({ email, name });
  }
  return { rows, invalid, duplicates };
}

/** CSV with an optional header row naming an "email" column (and "name" or "first name"); otherwise column 1 is the email and column 2 the name. */
export function parseRecipientsCsv(csv: string): ParsedRecipients & { tooMany: boolean } {
  const records = parseCsv(csv);
  const head = records[0]?.cells.map((c) => c.trim().toLowerCase()) ?? [];
  const hasHeader = head.some((h) => /^e-?mail/.test(h));
  const emailCol = hasHeader ? head.findIndex((h) => /^e-?mail/.test(h)) : 0;
  const nameCol = hasHeader ? head.findIndex((h) => /^(first[ _-]?name|name|full[ _-]?name)$/.test(h)) : 1;
  const body = hasHeader ? records.slice(1) : records;
  const raw = body.map((r) => ({ email: r.cells[emailCol] ?? "", name: nameCol >= 0 ? (r.cells[nameCol] ?? null) : null }));
  const tooMany = raw.length > MAX_RECIPIENTS_PER_IMPORT;
  return { ...cleanRecipients(raw.slice(0, MAX_RECIPIENTS_PER_IMPORT)), tooMany };
}

/** True when the client's local clock is inside the sending window. */
export function inSendWindow(now: Date, timeZone: string): boolean {
  const h = localParts(now, timeZone).hour;
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || "there";
export const fill = (t: string, v: { name: string | null; business: string }) =>
  t.replaceAll("{name}", firstName(v.name)).replaceAll("{business}", v.business);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The legal footer (legal review, "Review-request email footer"). `listPhrase` is what the recipient did
 * ("bought from", "booked with", "visited") and `listDate` is when the list was uploaded; with both, the
 * line says they did it within the 24 months before that month. The number part is left out when the
 * business has none. Every field is the business's own, stored under the client's settings.
 */
export function reviewRequestFooter(p: {
  business: string;
  sender: SenderIdentity;
  unsubscribeUrl: string;
  listPhrase?: string | null;
  listDate?: Date | null;
}) {
  const legal = p.sender.legalName?.trim() ?? "";
  const num = p.sender.companyNumber?.trim();
  const reason = p.listPhrase
    ? `because you ${p.listPhrase} ${p.business}${p.listDate ? ` within the 24 months before ${MONTHS[p.listDate.getUTCMonth()]} ${p.listDate.getUTCFullYear()}` : ""}`
    : `because ${p.business} has your email address`;
  const contact = [p.sender.phone?.trim(), p.sender.website?.trim()].filter(Boolean).join(", ");
  const head = `You are receiving this from ${legal}${num ? ` (${num})` : ""} ${reason}.`;
  const addr = `${p.sender.postalAddress?.trim() ?? ""}${contact ? ` \u00b7 ${contact}` : ""}.`;
  const unsubLabel = `Unsubscribe from ${p.business}'s review requests`;
  const tail = `Sent by OpenGMB for ${p.business}; OpenGMB is operated by ${OPERATOR_LEGAL_ENTITY}, ${OPERATOR_REGISTERED_OFFICE}.`;
  return {
    text: `${head} ${addr} ${unsubLabel}: ${p.unsubscribeUrl} (one click, no sign-in). ${tail}`,
    html: `<p style="font-size:12px;color:#555">${escapeHtml(head)} ${escapeHtml(addr)} <a href="${escapeHtml(p.unsubscribeUrl)}">${escapeHtml(unsubLabel)}</a> (one click, no sign-in). ${escapeHtml(tail)}</p>`,
  };
}

export function buildReviewRequestEmail(p: {
  subject: string;
  body: string;
  business: string;
  /** The business's stored sender identity (legal name and postal address are required to send). */
  sender: SenderIdentity;
  /** How the list was obtained ("bought from", "booked with", "visited") and when it was uploaded. */
  listPhrase?: string | null;
  listDate?: Date | null;
  recipientName: string | null;
  brand: Pick<EmailBrand, "logoUrl" | "primaryColor">;
  clickUrl: string;
  unsubscribeUrl: string;
  reminder: boolean;
}) {
  const v = { name: p.recipientName, business: p.business };
  const subject = (p.reminder ? "Reminder: " : "") + fill(p.subject, v);
  const paragraphs = fill(p.body, v).split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const { html, text } = renderBrandedEmail(
    { agencyName: p.business, logoUrl: p.brand.logoUrl, primaryColor: p.brand.primaryColor },
    { heading: p.business, paragraphs, cta: { label: "Leave a Google review", url: p.clickUrl } },
  );
  const foot = reviewRequestFooter(p);
  return {
    subject,
    html: html.replace(/<\/div>$/, `${foot.html}</div>`),
    text: `${text}\n\n${foot.text}`,
    headers: {
      "List-Unsubscribe": `<${p.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Public base URL for links in emails, or null when not configured (then nothing is sent). */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const b = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  return b && /^https?:\/\//.test(b) ? b : null;
}
export const clickUrl = (base: string, token: string) => `${base}/e/${token}`;
export const unsubscribeUrl = (base: string, token: string) => `${base}/e/${token}/unsubscribe`;
