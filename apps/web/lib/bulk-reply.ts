// Pure logic for the Bulk reply view: rows, counts, selection, the sequential draft runner and the
// agent prompt. Client-safe: only a type comes from core (erased at build).
import type { reviewsListUnreplied } from "@opengmb/core";
import { guardrailLabel } from "./labels";
import { enTr, type Tr } from "./reviews-tools-t";
import type { TimeFormat } from "./time-format";

export type UnrepliedItem = Awaited<ReturnType<typeof reviewsListUnreplied.handler>>["items"][number];

/** Our own cap per click: keeps one run under about a minute and the result list readable. */
export const BULK_DRAFT_MAX = 50;
export const BULK_PAGE = 50;

export type RowStatus = { tone: "good" | "bad" | "neutral"; label: string };
export type BulkRow = {
  id: string;
  rating: number | null;
  reviewer: string;
  text: string;
  where: string;
  selectable: boolean;
  status: RowStatus;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** `ws` is the review's client when the caller knows it; else the page's client. */
export function bulkRow(i: UnrepliedItem, tf: TimeFormat, ws?: string | null, t: Tr = enTr): BulkRow {
  const reviewer = i.reviewer.isAnonymous ? t("anonymous") : (i.reviewer.displayName ?? t("unknown"));
  const base = {
    id: i.id,
    rating: i.rating,
    reviewer,
    text: i.comment ? clip(i.comment.replace(/\s+/g, " ").trim(), 120) : t("bulk.noWritten"),
    where: `${i.location.name} · ${tf.date(i.createTime, ws)}`,
  };
  if (!i.replyAllowed) {
    return { ...base, selectable: false, status: { tone: "neutral", label: t("bulk.skipped", { reason: i.skipReason ?? t("bulk.replyNotAllowed") }) } };
  }
  if (i.reply) {
    return { ...base, selectable: true, status: { tone: "bad", label: t("bulk.rejected") } };
  }
  return { ...base, selectable: true, status: { tone: "good", label: t("bulk.canReply") } };
}

export const visibleRows = (rows: BulkRow[], showSkipped: boolean) =>
  showSkipped ? rows : rows.filter((r) => r.selectable);

export function bulkCounts(rows: BulkRow[]) {
  const canReply = rows.filter((r) => r.selectable).length;
  return { displayed: rows.length, canReply, skipped: rows.length - canReply };
}

const selectableIds = (rows: BulkRow[]) => rows.filter((r) => r.selectable).map((r) => r.id);
export const toggleOne = (sel: string[], id: string) =>
  sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
export function toggleAll(sel: string[], rows: BulkRow[]): string[] {
  const all = selectableIds(rows);
  return all.length > 0 && all.every((id) => sel.includes(id)) ? [] : all;
}
export const pruneSelection = (sel: string[], rows: BulkRow[]) =>
  sel.filter((id) => rows.some((r) => r.id === id && r.selectable));

export const markDrafted = (rows: BulkRow[], ids: string[], t: Tr = enTr): BulkRow[] =>
  rows.map((r) =>
    ids.includes(r.id)
      ? { ...r, selectable: false, status: { tone: "neutral", label: t("bulk.drafted") } }
      : r,
  );

export const draftLabel = (n: number, t: Tr = enTr) => (n === 0 ? t("bulk.createDrafts") : t("bulk.createN", { count: n }));

/** The Rating filter: "1-3" and "1-2" are the board's options; anything else is any rating. `label` is a message key. */
export function ratingsFromParam(v: string | undefined): number[] | undefined {
  if (v === "1-3") return [1, 2, 3];
  if (v === "1-2") return [1, 2];
  return undefined;
}
export const RATING_OPTIONS = [
  { value: "", label: "bulk.ratingAny" },
  { value: "1-3", label: "bulk.rating13" },
  { value: "1-2", label: "bulk.rating12" },
];

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export type DraftOutcome = { reviewId: string; status: "created" | "skipped"; reason?: string };

/** Render the template, then create the draft, one review after another; a failure becomes a skipped row with `CODE: message`. */
export async function createDraftsSequentially(
  ids: string[],
  deps: { render: (reviewId: string) => Promise<Result>; createDraft: (reviewId: string, body: string) => Promise<Result> },
): Promise<DraftOutcome[]> {
  const out: DraftOutcome[] = [];
  for (const reviewId of ids.slice(0, BULK_DRAFT_MAX)) {
    try {
      const rendered = await deps.render(reviewId);
      if (!rendered.ok) {
        out.push({ reviewId, status: "skipped", reason: `${rendered.error.code}: ${rendered.error.message}` });
        continue;
      }
      const draft = await deps.createDraft(reviewId, (rendered.data as { body: string }).body);
      out.push(
        draft.ok
          ? { reviewId, status: "created" }
          : { reviewId, status: "skipped", reason: `${draft.error.code}: ${draft.error.message}` },
      );
    } catch {
      out.push({ reviewId, status: "skipped", reason: "INTERNAL: request failed" });
    }
  }
  return out;
}

/** Our own cap per AI click; the same number core enforces (AI_DEFAULTS.bulkDraftMax). */
export const BULK_AI_MAX = 20;

export type AiItem = {
  reviewId: string;
  outcome: "drafted" | "blocked" | "refused" | "skipped" | "failed" | "not_attempted";
  replyStatus: string | null;
  reason: string | null;
  blockedRuleIds: string[];
  warningRuleIds: string[];
};
export type AiResult = {
  results: AiItem[];
  counts: { drafted: number; blocked: number; refused: number; skipped: number; failed: number; notAttempted: number };
  stoppedOverCap: boolean;
};

const ruleNames = (ids: string[]) => ids.map((id) => guardrailLabel(id)).join(", ");

/** One result line per review: what happened, in plain words. */
export function aiOutcomeLine(i: AiItem, t: Tr = enTr): string {
  const reason = i.reason ?? "";
  switch (i.outcome) {
    case "drafted":
      if (i.replyStatus === "draft") return t("bulk.aiHeld", { rules: ruleNames(i.warningRuleIds) });
      return i.warningRuleIds.length > 0
        ? t("bulk.aiDraftedWarn", { rules: ruleNames(i.warningRuleIds) })
        : t("bulk.aiDrafted");
    case "blocked":
      return t("bulk.aiBlocked", { rules: ruleNames(i.blockedRuleIds) });
    case "refused":
      return t("bulk.aiRefused", { reason });
    case "skipped":
      return t("bulk.aiSkipped", { reason });
    case "failed":
      return t("bulk.aiFailed", { reason });
    case "not_attempted":
      return t("bulk.aiNotTried", { reason });
  }
}

export const aiSummaryText = (r: AiResult, t: Tr = enTr) =>
  t("bulk.aiSummary", {
    drafted: r.counts.drafted,
    blocked: r.counts.blocked,
    skipped: r.counts.skipped,
    refused: r.counts.refused + r.counts.notAttempted,
    failed: r.counts.failed,
  });

export function summaryText(out: DraftOutcome[], t: Tr = enTr): string {
  const created = out.filter((o) => o.status === "created").length;
  const skipped = out.length - created;
  return `${t("bulk.summaryCreated", { count: created })}${skipped ? ` ${t("bulk.summarySkipped", { count: skipped })}` : ""}`;
}

/** What "Copy for my agent" puts on the clipboard: ids and rules only, never review text or names. */
export function agentPrompt(p: { workspaceName: string; ids: string[] }): string {
  return [
    `Draft replies to Google reviews in OpenGMB, client "${p.workspaceName}", using the OpenGMB MCP tools.`,
    "",
    "For each review id below:",
    "1. Call reviews_get to read the review. Skip it if it already has a visible reply.",
    "2. Write a short reply: thank the reviewer, apologise where it is fair, offer to talk offline. Never mention a condition, treatment, staff member or any detail of the visit. No links, phone numbers or offers.",
    "3. Call reviewReplies_check with the reply, fix anything it flags, then call reviewReplies_createDraft.",
    "",
    "Stop at the draft. Do not call reviewReplies_submit, reviewReplies_approve or reviewReplies_publish: a person checks and approves every draft in OpenGMB.",
    "",
    `Review ids (${p.ids.length}):`,
    ...p.ids.map((id) => `- ${id}`),
  ].join("\n");
}
