"use client";
import { useAiNotice } from "../ai-notice";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ai_draftReplies, replyTemplates_render, reviewReplies_createDraft, reviews_list_unreplied } from "../../app/_generated/actions";
import {
  BULK_AI_MAX, BULK_DRAFT_MAX, BULK_PAGE, agentPrompt, aiOutcomeLine, aiSummaryText, bulkCounts, bulkRow, createDraftsSequentially, draftLabel,
  markDrafted, pruneSelection, summaryText, toggleAll, toggleOne, visibleRows,
  type AiResult, type BulkRow, type DraftOutcome,
} from "../../lib/bulk-reply";
import { ReviewStars } from "../review-stars";
import { filterFieldClass, Pill } from "../page-parts";
import { useTimeFormat } from "../time-format-provider";
import { ErrorText, buttonClass, secondaryButtonClass } from "../ui";

type Template = { id: string; name: string; allowed: boolean };
const checkbox = "size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring";

export function BulkReply(p: {
  workspaceId: string;
  workspaceName: string;
  templates: Template[];
  filters: { locationIds?: string[]; ratings?: number[] };
  initialRows: BulkRow[];
  initialCursor: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("reviewsTools");
  const tf = useTimeFormat();
  const notice = useAiNotice();
  const [rows, setRows] = useState(p.initialRows);
  const [cursor, setCursor] = useState(p.initialCursor);
  const [selected, setSelected] = useState<string[]>([]);
  const [showSkipped, setShowSkipped] = useState(true);
  const usable = p.templates.filter((x) => x.allowed);
  const [templateId, setTemplateId] = useState(usable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<DraftOutcome[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const counts = bulkCounts(rows);
  const shown = visibleRows(rows, showSkipped);
  const live = pruneSelection(selected, rows);
  const tooMany = live.length > BULK_DRAFT_MAX;
  const aiTooMany = live.length > BULK_AI_MAX;
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.reviewer ?? id;

  async function create() {
    setBusy(true);
    setError(null);
    const out = await createDraftsSequentially(live, {
      render: (reviewId) => replyTemplates_render({ templateId, reviewId }),
      createDraft: (reviewId, body) => reviewReplies_createDraft({ reviewId, body }),
    });
    setOutcomes(out);
    const done = out.filter((o) => o.status === "created").map((o) => o.reviewId);
    setRows((r) => markDrafted(r, done, t));
    setSelected((s) => s.filter((id) => !done.includes(id)));
    setBusy(false);
    router.refresh();
  }

  /** One AI draft per selected review, saved and sent to approval by core; rows that got a draft stop being selectable. */
  async function createWithAi() {
    if (!(await notice.ready())) return;
    setBusy(true);
    setAiBusy(true);
    setError(null);
    setOutcomes(null);
    const r = await ai_draftReplies({ reviewIds: live });
    setAiBusy(false);
    if (!r.ok) {
      setError(`${r.error.code}: ${r.error.message}`);
      setBusy(false);
      return;
    }
    const d = r.data as AiResult;
    setAiResult(d);
    const done = d.results.filter((x) => x.outcome === "drafted").map((x) => x.reviewId);
    setRows((x) => markDrafted(x, done, t));
    setSelected((s) => s.filter((id) => !done.includes(id)));
    setBusy(false);
    router.refresh();
  }

  async function more() {
    setBusy(true);
    setError(null);
    const r = await reviews_list_unreplied({ workspaceId: p.workspaceId, ...p.filters, includeSkipped: true, limit: BULK_PAGE, cursor });
    if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
    else {
      const d = r.data as { items: Parameters<typeof bulkRow>[0][]; nextCursor: string | null };
      setRows((x) => [...x, ...d.items.map((i) => bulkRow(i, tf, p.workspaceId, t))]);
      setCursor(d.nextCursor);
    }
    setBusy(false);
  }

  async function copy() {
    const text = agentPrompt({ workspaceName: p.workspaceName, ids: live });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFallback(null);
    } catch {
      setFallback(text);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice.dialog}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-panel border border-brand/40 bg-brand-tint px-3.5 py-3">
        <strong>
          {t("bulk.selected", { count: live.length })} <span className="font-medium text-muted-foreground">{t("bulk.ofCanReply", { count: counts.canReply })}</span>
        </strong>
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          {t("bulk.template")}
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={filterFieldClass} disabled={usable.length === 0}>
            {p.templates.map((x) => (
              <option key={x.id} value={x.id} disabled={!x.allowed}>
                {x.allowed ? x.name : t("bulk.templateNotAllowed", { name: x.name })}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={buttonClass} disabled={busy || live.length === 0 || tooMany || !templateId} onClick={create}>
          {draftLabel(live.length, t)}
        </button>
        <button type="button" className={buttonClass} disabled={busy || live.length === 0 || aiTooMany} onClick={createWithAi}>
          {aiBusy ? t("bulk.aiRunning") : live.length === 0 ? t("bulk.aiDrafts") : t("bulk.aiDraftsN", { count: live.length })}
        </button>
        <span className="text-[13px] text-muted-foreground">{t("bulk.or")}</span>
        <button
          type="button"
          onClick={copy}
          disabled={live.length === 0}
          className="inline-flex min-h-(--control-h) items-center rounded-control border border-agent-border bg-agent-bg px-3.5 text-sm font-semibold text-agent disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t("bulk.copyAgent")}
        </button>
        <span className="ml-auto text-[13px] text-muted-foreground">{t("bulk.draftsAppear")}</span>
        {copied && <span role="status" className="basis-full text-[13px] text-good">{t("bulk.copiedPaste")}</span>}
        <span className="basis-full text-[13px] text-muted-foreground">{t("bulk.aiHint")}</span>
        {aiTooMany && <span className="basis-full text-[13px] text-bad">{t("bulk.aiTooMany", { max: BULK_AI_MAX })}</span>}
        {tooMany && <span className="basis-full text-[13px] text-bad">{t("bulk.tooMany", { max: BULK_DRAFT_MAX })}</span>}
        {usable.length === 0 && (
          <span className="basis-full text-[13px] text-muted-foreground">
            {t.rich("bulk.noTemplate", {
              templates: (chunks) => (
                <Link href="/settings/templates" className="font-semibold text-brand-text underline underline-offset-2">{chunks}</Link>
              ),
            })}
          </span>
        )}
      </div>
      {fallback !== null && (
        <textarea readOnly aria-label={t("bulk.promptAria")} value={fallback} rows={8} className="w-full rounded-control border border-input bg-card p-2 font-mono text-xs" />
      )}
      <ErrorText message={error} />

      {aiResult && (
        <section aria-label={t("bulk.aiResultsAria")} className="flex flex-col gap-1 rounded-panel border border-border bg-card px-3.5 py-3 text-sm">
          <strong role="status">{aiSummaryText(aiResult, t)}</strong>
          {aiResult.stoppedOverCap && <span className="text-bad">{t("bulk.aiStoppedCap")}</span>}
          {aiResult.results.map((i) => (
            <span key={i.reviewId} className="text-muted-foreground">
              {nameOf(i.reviewId)}: {aiOutcomeLine(i, t)}
            </span>
          ))}
          {aiResult.counts.drafted > 0 && (
            <Link href="/approvals" className="font-semibold text-brand-text underline underline-offset-2">{t("bulk.openApprovals")}</Link>
          )}
        </section>
      )}

      {outcomes && (
        <section aria-label={t("bulk.resultsAria")} className="flex flex-col gap-1 rounded-panel border border-border bg-card px-3.5 py-3 text-sm">
          <strong role="status">{summaryText(outcomes, t)}</strong>
          {outcomes.filter((o) => o.status === "skipped").map((o) => (
            <span key={o.reviewId} className="text-muted-foreground">{nameOf(o.reviewId)}: {o.reason}</span>
          ))}
          {outcomes.some((o) => o.status === "created") && (
            <Link href="/reviews?replied=no" className="font-semibold text-brand-text underline underline-offset-2">{t("bulk.openInbox")}</Link>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className={checkbox} checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} />
          {t("bulk.showSkipped", { count: counts.skipped })}
        </label>
        <span className="ml-auto">
          <strong>{t("bulk.displayed", { count: showSkipped ? counts.displayed : counts.canReply })}</strong>{" "}
          <span className="text-muted-foreground">{t("bulk.counts", { canReply: counts.canReply, skipped: counts.skipped })}</span>
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[900px] border-collapse text-[13px]">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th scope="col" className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  className={checkbox}
                  aria-label={t("bulk.selectAllAria")}
                  disabled={counts.canReply === 0}
                  checked={counts.canReply > 0 && live.length === counts.canReply}
                  onChange={() => setSelected(toggleAll(live, rows))}
                />
              </th>
              <th scope="col" className="w-[90px] px-3 py-2 font-semibold">{t("bulk.colRating")}</th>
              <th scope="col" className="px-3 py-2 font-semibold">{t("bulk.colReview")}</th>
              <th scope="col" className="w-[190px] px-3 py-2 font-semibold">{t("bulk.colLocationDate")}</th>
              <th scope="col" className="w-[260px] px-3 py-2 font-semibold">{t("bulk.colStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={`border-t border-border ${live.includes(r.id) ? "bg-brand-tint" : ""} ${r.selectable ? "" : "bg-muted"}`}>
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    className={checkbox}
                    aria-label={t("bulk.selectFrom", { name: r.reviewer })}
                    disabled={!r.selectable}
                    checked={live.includes(r.id)}
                    onChange={() => setSelected(toggleOne(live, r.id))}
                  />
                </td>
                <td className="px-3 py-2.5"><ReviewStars rating={r.rating} /></td>
                <td className="px-3 py-2.5"><strong className="font-semibold">{r.reviewer}</strong> <span className="text-foreground">{r.text}</span></td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.where}</td>
                <td className="px-3 py-2.5"><Pill tone={r.status.tone === "good" ? "good" : r.status.tone === "bad" ? "bad" : "neutral"}>{r.status.label}</Pill></td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">{t("bulk.nothing")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button type="button" onClick={more} disabled={busy} className={`${secondaryButtonClass} self-start`}>{t("bulk.loadMore")}</button>
      )}
    </div>
  );
}
