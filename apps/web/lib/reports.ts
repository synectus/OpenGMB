// apps/web/lib/reports.ts
// Pure decisions for /reports. No core value imports (web lib tests run without the DB package);
// numbers owned by config (size cap, link days, cron) are passed in by the pages.
import { enTr, type Tr } from "./performance";
import type { TimeFormat } from "./time-format";

/** English for every string built in this file. messages/pages/reports.ts spreads it into `en`. */
export const REPORTS_EN = {
  scopeWhole: "Whole client",
  scopeLocationsOne: "1 chosen location",
  scopeLocationsMany: "{n} chosen locations",
  scopeGroup: "Group {name}",
  scopeGroupDeleted: "Group deleted",
  periodLastMonth: "Last month",
  periodLast30: "Last 30 days",
  periodCustom: "{from} to {to}",
  kindReview: "Review",
  kindPerformance: "Performance",
  languageEs: "Spanish",
  languageEn: "English",
  emailRecipientsOne: "to 1 recipient",
  emailRecipientsMany: "to {n} recipients",
  emailOff: "off",
  triggerManualBy: "manual · {name}",
  triggerManual: "manual",
  triggerSchedule: "schedule",
  waitQueued: "Waiting for the worker",
  waitRunning: "Building the PDF",
  errPdfTooLarge: "PDF over the {mb} MB size cap",
  errRenderFailed: "The PDF could not be built. Generate it again.",
  errDefinitionMissing: "The report definition was deleted.",
  errGroupMissing: "The group of this report was deleted. Pick another scope.",
  hintPdfTooLarge: "Pick fewer locations or a shorter period.",
  emailedNotSent: "Not sent yet",
  emailedNoEmail: "Not sent: email is not set up",
  linkUntil: "until {date}",
  linkInactive: "inactive",
  linkRevoked: "Revoked on {date}. The link no longer opens.",
  ordinalOne: "{n}st",
  ordinalTwo: "{n}nd",
  ordinalFew: "{n}rd",
  ordinalOther: "{n}th",
  scheduleNote: "Each recipient gets a {days}-day link, never an attachment. Sent on the {day} at {time} {zone}.",
  commentCount: "{n} of {max} characters",
  invalidName: "Give the report a name",
  invalidGroup: "Pick a group",
  invalidLocations: "Pick at least one location",
  invalidCustom: "A custom period needs both dates",
  invalidRecipients: "A monthly email needs at least one recipient",
  invalidComment: "The comment is {n} characters; the limit is {max}",
  invalidColour: "Use a colour like #1F4E79",
} as const;
const en = enTr(REPORTS_EN);

export const COMMENT_MAX = 500; // mirrors core REPORT_COMMENT_MAX; core re-checks on save
const HEX = /^#[0-9a-fA-F]{6}$/;

export function scopeText(
  d: { scope: string; locationIds: string[]; groupId: string | null },
  groupNames: Map<string, string>,
  t: Tr = en,
): string {
  if (d.scope === "workspace") return t("scopeWhole");
  if (d.scope === "locations") {
    const n = d.locationIds.length;
    return n === 1 ? t("scopeLocationsOne") : t("scopeLocationsMany", { n });
  }
  const name = d.groupId ? groupNames.get(d.groupId) : undefined;
  return name ? t("scopeGroup", { name }) : t("scopeGroupDeleted");
}

export function periodText(d: { period: string; customFrom: string | null; customTo: string | null }, tf: TimeFormat, ws?: string | null, t: Tr = en) {
  if (d.period === "last_month") return t("periodLastMonth");
  if (d.period === "last_30_days") return t("periodLast30");
  return t("periodCustom", { from: tf.day(d.customFrom!, ws), to: tf.day(d.customTo!, ws) });
}

export const kindText = (k: string, t: Tr = en) => t(k === "reviews" ? "kindReview" : "kindPerformance");

export const languageText = (l: string, t: Tr = en) => t(l === "es" ? "languageEs" : "languageEn");

export const emailText = (d: { schedule: string; recipients: string[] }, t: Tr = en) =>
  d.schedule !== "monthly" ? t("emailOff") : d.recipients.length === 1 ? t("emailRecipientsOne") : t("emailRecipientsMany", { n: d.recipients.length });

export const activeCount = (defs: unknown[]) => `Active: ${defs.length}`;

export const triggerText = (r: { trigger: string; requestedByName: string | null }, t: Tr = en) =>
  r.trigger === "manual" ? (r.requestedByName ? t("triggerManualBy", { name: r.requestedByName }) : t("triggerManual")) : t("triggerSchedule");

export const statusWait = (s: string, t: Tr = en) =>
  s === "queued" ? t("waitQueued") : s === "running" ? t("waitRunning") : null;

const RUN_ERRORS: Record<string, string> = {
  pdf_too_large: "errPdfTooLarge",
  render_failed: "errRenderFailed",
  definition_missing: "errDefinitionMissing",
  group_missing: "errGroupMissing",
};

export function runErrorText(code: string, pdfMaxBytes: number, t: Tr = en): string {
  const mb = Math.round(pdfMaxBytes / (1024 * 1024));
  const key = RUN_ERRORS[code];
  return key ? `${code}: ${t(key, { mb })}` : code;
}

export const runErrorHint = (code: string, t: Tr = en) => (code === "pdf_too_large" ? t("hintPdfTooLarge") : null);

export function emailedText(r: { trigger: string; emailedAt: string | null }, emailOn: boolean, tf: TimeFormat, ws?: string | null, t: Tr = en) {
  if (r.emailedAt) return tf.dateTime(r.emailedAt, ws);
  if (r.trigger !== "schedule") return "·";
  return emailOn ? t("emailedNotSent") : t("emailedNoEmail");
}

type Link = { id: string; expiresAt: string; revokedAt: string | null; createdAt: string; active: boolean };

/** The share-link cell: the newest active link (with Revoke), else "inactive" (with the revoke date), else a dot. */
export function linkCell(links: Link[], tf: TimeFormat, ws?: string | null, t: Tr = en): { text: string; revokeId: string | null; note: string | null } {
  const newest = [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = newest.find((l) => l.active);
  if (active) return { text: t("linkUntil", { date: tf.date(active.expiresAt, ws) }), revokeId: active.id, note: null };
  if (newest.length === 0) return { text: "·", revokeId: null, note: null };
  const revoked = newest.find((l) => l.revokedAt);
  return {
    text: t("linkInactive"),
    revokeId: null,
    note: revoked ? t("linkRevoked", { date: tf.date(revoked.revokedAt!, ws) }) : null,
  };
}

export const expiryOptions = (maxDays: number) => [1, 7, 14, 30].filter((d) => d <= maxDays);

// English picks the suffix here; Hindi and Spanish map all four keys to the bare number.
const ordinal = (n: number, t: Tr) =>
  t(n % 100 >= 11 && n % 100 <= 13 ? "ordinalOther" : (["ordinalOther", "ordinalOne", "ordinalTwo", "ordinalFew"][n % 10] ?? "ordinalOther"), { n });

/** From PERFORMANCE_CONFIG.monthlyReportCron ("m h dom * *") and monthlyEmailLinkDays. */
export function scheduleText(cron: string, linkDays: number, tf: TimeFormat, ws?: string | null, t: Tr = en) {
  const [m, h, dom] = cron.split(" ");
  return t("scheduleNote", { days: linkDays, day: ordinal(Number(dom), t), time: `${h!.padStart(2, "0")}:${m!.padStart(2, "0")}`, zone: tf.label(ws) });
}

export const commentCount = (s: string, t: Tr = en) => t("commentCount", { n: s.trim().length, max: COMMENT_MAX });

export type EditorState = {
  kind: "performance" | "reviews";
  workspaceId: string;
  name: string;
  scope: "workspace" | "locations" | "group";
  groupId: string;
  locationIds: string[];
  period: "last_month" | "last_30_days" | "custom";
  customFrom: string;
  customTo: string;
  language: "en" | "es";
  comment: string;
  aiSummary: boolean;
  agencyName: string;
  colour: string;
  schedule: "none" | "monthly";
  recipients: string;
};

/** Form state to reports.definitions.create/update input, with the obvious checks done first. */
export function definitionInput(s: EditorState, t: Tr = en) {
  const fail = (key: string, values?: Record<string, string | number>) => ({ ok: false as const, error: `INVALID_INPUT: ${t(key, values)}` });
  const name = s.name.trim();
  if (!name) return fail("invalidName");
  if (s.scope === "group" && !s.groupId) return fail("invalidGroup");
  if (s.scope === "locations" && s.locationIds.length === 0) return fail("invalidLocations");
  if (s.period === "custom" && (!s.customFrom || !s.customTo)) return fail("invalidCustom");
  const recipients = s.recipients.split(",").map((r) => r.trim()).filter(Boolean);
  if (s.schedule === "monthly" && recipients.length === 0) return fail("invalidRecipients");
  const comment = s.comment.trim();
  if (comment.length > COMMENT_MAX) return fail("invalidComment", { n: comment.length, max: COMMENT_MAX });
  const colour = s.colour.trim();
  if (colour && !HEX.test(colour)) return fail("invalidColour");
  const agencyName = s.agencyName.trim();
  return {
    ok: true as const,
    input: {
      workspaceId: s.workspaceId,
      kind: s.kind,
      name,
      scope: s.scope,
      locationIds: s.scope === "locations" ? s.locationIds : [],
      groupId: s.scope === "group" ? s.groupId : null,
      period: s.period,
      customFrom: s.period === "custom" ? s.customFrom : null,
      customTo: s.period === "custom" ? s.customTo : null,
      language: s.language,
      comment: comment || null,
      aiSummary: s.aiSummary,
      schedule: s.schedule,
      recipients,
      branding: { ...(agencyName ? { agencyName } : {}), ...(colour ? { colour } : {}) },
    },
  };
}
