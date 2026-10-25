"use client";
import { useAiNotice } from "./ai-notice";
import { Check } from "lucide-react";
import { guardrailLabel, statusLabel } from "../lib/labels";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  ai_draftReply,
  reviewReplies_approve,
  reviewReplies_check,
  reviewReplies_createDraft,
  reviewReplies_deletePublished,
  reviewReplies_list,
  reviewReplies_publish,
  reviewReplies_reject,
  reviewReplies_submit,
  reviewReplies_updateDraft,
  replyTemplates_render,
} from "../app/_generated/actions";
import { buttonClass, ErrorText } from "./ui";
import { failureLabel } from "../lib/failure-labels";

export type Violation = {
  ruleId: string;
  severity: "block" | "warn";
  status: "active" | "pending_counsel_review";
  message: string;
  /** Text the rule matched (post rules: P.phone). Shown only where the caller opts in. */
  matches?: { text: string; start: number; end: number }[];
};
export type GuardrailResult = { ok: boolean; violations: Violation[]; packs: string[] };
export type Reply = {
  id: string;
  revision: number;
  body: string;
  status: string;
  rejectReason: string | null;
  failureReason: string | null;
  /** status conflict: Google's reply when the publish was refused (null = it had been deleted). */
  conflictGoogleComment?: string | null;
  publishPending: boolean;
  guardrail: GuardrailResult | null;
  /** The star rule's minimum stars when it approved this reply (not a person); null otherwise. */
  autoApprovedMinStars: number | null;
  can: { edit: boolean; submit: boolean; approve: boolean; reject: boolean; publish: boolean };
};
export type TemplateOption = { id: string; name: string; allowed: boolean };
export type ReplyData = {
  revisions: Reply[];
  review: {
    hasGoogleReply: boolean;
    openRevisionId: string | null;
    canDraft: boolean;
    canDeletePublished: boolean;
  };
};

const OPEN = ["draft", "pending_approval", "approved", "blocked", "failed"];
const POLL_MS = 1500;
const POLL_TRIES = 40;
const small =
  "inline-flex min-h-9 items-center justify-center rounded-control border border-input bg-card px-3 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
// Its own string, not `small` plus overrides: with Tailwind v4 the CSS order, not the class order, decides.
const danger =
  "inline-flex min-h-9 items-center justify-center rounded-control border border-bad-border bg-bad-bg px-3 text-[13px] font-semibold text-bad hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const NOTE_TONE = {
  info: "bg-info-bg text-info",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
} as const;
type Note = { tone: keyof typeof NOTE_TONE; text: string };

export function Violations({ result, showMatches = false }: { result: GuardrailResult; showMatches?: boolean }) {
  const tr = useTranslations("reviews");
  if (result.violations.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-good-bg px-3 py-2 text-sm font-semibold text-good">
        <Check aria-hidden className="size-3.5" />
        {tr("violations.none")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 text-sm" aria-label={tr("violations.list")}>
      {result.violations.map((v, i) => (
        <li
          key={`${v.ruleId}-${i}`}
          title={tr("violations.rule", { id: v.ruleId })}
          className={`rounded-lg border px-3 py-2 ${
            v.severity === "block" ? "border-bad-border bg-bad-bg" : "border-warn-border bg-warn-bg"
          }`}
        >
          <span className={`font-semibold ${v.severity === "block" ? "text-bad" : "text-warn"}`}>
            {v.severity === "block" ? tr("violations.blocks") : tr("violations.warning")}
            {v.status === "pending_counsel_review" ? tr("violations.pendingCounsel") : ""}:
          </span>{" "}
          {guardrailLabel(v.ruleId, v.message)}
          {showMatches && v.matches?.length ? (
            <span className="mt-1 block text-muted-foreground">
              {tr("violations.found")}{" "}
              {v.matches.map((m, j) => (
                <span key={j}>
                  {j > 0 && ", "}
                  <mark className="rounded-sm bg-bad-border px-1 text-foreground">{m.text}</mark>
                </span>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Reply editor for one review. What each button does comes from the `can` flags and `review`
 * capabilities core returns, never from the user's role. Publishing is asynchronous: after Publish
 * the panel polls reviewReplies.list until the worker settles it. State is seeded from `initial` and
 * never re-synced from props, so callers key the panel by review id.
 */
export function ReplyPanel({
  reviewId,
  googleReply,
  initial,
  refreshOnChange = true,
  templates = [],
}: {
  reviewId: string;
  googleReply: string | null;
  initial: ReplyData;
  refreshOnChange?: boolean;
  templates?: TemplateOption[];
}) {
  const tr = useTranslations("reviews");
  const notice = useAiNotice();
  const router = useRouter();
  const [data, setData] = useState(initial);
  const open = data.revisions.find((r) => OPEN.includes(r.status)) ?? null;
  // Revisions are newest first: a conflict is only shown while it is the latest revision.
  const conflict = !open && data.revisions[0]?.status === "conflict" ? data.revisions[0] : null;
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState(open?.body ?? "");
  const [checked, setChecked] = useState<GuardrailResult | null>(null);
  const [ack, setAck] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const shown = checked ?? open?.guardrail ?? null;
  const hasWarnings = (shown?.violations ?? []).some((v) => v.severity === "warn");
  const dirty = open !== null && body !== open.body;
  // The revision whose approval the chip describes: the open one once approved, else the published one.
  const approvedRevision = open
    ? open.status === "approved" || open.status === "failed"
      ? open
      : null
    : (data.revisions.find((r) => r.status === "published") ?? null);
  const autoApprovedStars = approvedRevision?.autoApprovedMinStars ?? null;

  async function reload(): Promise<ReplyData | null> {
    const r = await reviewReplies_list({ reviewId });
    if (!r.ok) {
      setError(`${r.error.code}: ${r.error.message}`);
      return null;
    }
    const next = r.data as ReplyData;
    setData(next);
    const o = next.revisions.find((x) => OPEN.includes(x.status));
    setBody(o?.body ?? "");
    return next;
  }

  /** Run one action; show its error, or reload the panel on success. */
  async function act<T>(
    fn: () => Promise<
      { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
    >,
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await fn();
    if (!r.ok) {
      setBusy(false);
      setError(`${r.error.code}: ${r.error.message}`);
      return null;
    }
    const out = r.data as T;
    await reload();
    setBusy(false);
    return out;
  }

  async function poll(done: (d: ReplyData) => boolean) {
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const d = await reload();
      if (!d || done(d)) break;
    }
    setBusy(false);
    if (refreshOnChange) router.refresh();
  }

  async function check() {
    setBusy(true);
    setError(null);
    const r = await reviewReplies_check({ reviewId, body });
    setBusy(false);
    if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
    else setChecked(r.data as GuardrailResult);
  }

  /** Render a saved template for this review into the textarea; confirm before replacing text. */
  async function insertTemplate(templateId: string) {
    if (templateId === "") return;
    setBusy(true);
    setError(null);
    const r = await replyTemplates_render({ templateId, reviewId });
    setBusy(false);
    if (!r.ok) {
      setError(`${r.error.code}: ${r.error.message}`);
      return;
    }
    if (
      body.trim() !== "" &&
      !window.confirm(tr("reply.confirmReplace"))
    ) {
      return;
    }
    setBody((r.data as { body: string }).body);
    setChecked(null);
  }

  /** Fill the editor with an AI draft. Nothing is saved: the draft goes through Check, Save and Submit like any text. */
  async function aiDraft() {
    if (body.trim() !== "" && !window.confirm(tr("reply.confirmReplaceAi"))) return;
    if (!(await notice.ready())) return;
    setBusy(true);
    setError(null);
    setNote({ tone: "info", text: tr("reply.aiWorking") });
    const r = await ai_draftReply({ reviewId });
    if (!r.ok) {
      setBusy(false);
      setNote(null);
      setError(`${r.error.code}: ${r.error.message}`);
      return;
    }
    const d = r.data as { status: string; draft: string | null; blockedRuleIds: string[] };
    if (d.status !== "ok" || d.draft === null) {
      setBusy(false);
      setNote({
        tone: "bad",
        text: tr("reply.aiBlocked", { rules: d.blockedRuleIds.map((id) => guardrailLabel(id)).join(", ") }),
      });
      return;
    }
    setComposing(true);
    setBody(d.draft);
    // Run the check at once so any warning (for example banned wording) is on screen before saving.
    const c = await reviewReplies_check({ reviewId, body: d.draft });
    setChecked(c.ok ? (c.data as GuardrailResult) : null);
    setAck(false);
    setBusy(false);
    setNote({ tone: "info", text: tr("reply.aiFilled") });
  }

  async function saveDraft() {
    if (open) {
      await act(() => reviewReplies_updateDraft({ id: open.id, body }));
    } else {
      await act(() => reviewReplies_createDraft({ reviewId, body }));
      setComposing(false);
    }
    setChecked(null);
  }

  async function submit() {
    if (!open) return;
    if (dirty) {
      const saved = await act(() => reviewReplies_updateDraft({ id: open.id, body }));
      if (!saved) return;
    }
    const out = await act<{ outcome: string; result: GuardrailResult }>(() =>
      reviewReplies_submit({ id: open.id, acknowledgeWarnings: ack }),
    );
    if (!out) return;
    setChecked(out.result);
    if (out.outcome === "needs_acknowledgement") {
      setNote({
        tone: "warn",
        text: tr("reply.needsAck"),
      });
    } else if (out.outcome === "blocked") {
      setNote({
        tone: "bad",
        text: tr("reply.blockedNote"),
      });
    } else if (refreshOnChange) router.refresh();
  }

  async function publish() {
    if (!open) return;
    const out = await act<{ queued: boolean }>(() =>
      reviewReplies_publish({ id: open.id, acknowledgeWarnings: ack }),
    );
    if (!out) return;
    setBusy(true);
    setNote({ tone: "info", text: tr("reply.publishingWait") });
    await poll((d) => !d.revisions.some((r) => r.publishPending));
    setNote(null);
  }

  async function remove() {
    if (!window.confirm(tr("reply.confirmDelete"))) return;
    const out = await act<{ queued: boolean }>(() => reviewReplies_deletePublished({ reviewId }));
    if (!out) return;
    setBusy(true);
    setNote({ tone: "info", text: tr("reply.deletingWait") });
    await poll((d) => !d.review.hasGoogleReply);
    setNote(null);
  }

  const status = open ? statusLabel(open.status) : null;
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4"
      aria-label={tr("reply.label")}
    >
      {notice.dialog}
      {googleReply !== null && (
        <figure className="m-0 rounded-lg bg-card p-3 text-[13px] leading-[19px]">
          <figcaption className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            {tr("reply.onGoogle")}
          </figcaption>
          <p className="whitespace-pre-wrap">{googleReply}</p>
        </figure>
      )}

      {autoApprovedStars !== null && (
        <span className="inline-flex h-6 items-center self-start rounded-md border border-warn-border bg-warn-bg px-2 text-xs font-semibold text-warn">
          {tr("reply.autoApproved", { stars: autoApprovedStars })}
        </span>
      )}

      {conflict && (
        <div
          role="alert"
          aria-label={tr("reply.conflictLabel")}
          className="flex flex-col gap-1.5 rounded-lg border border-bad-border bg-bad-bg p-3 text-sm text-bad"
        >
          <p>
            <strong>{tr("reply.conflictTitle")}</strong> {tr("reply.conflictNothing")}
          </p>
          {conflict.conflictGoogleComment ? (
            <blockquote className="border-l-2 border-bad-border pl-3">
              <span className="text-xs">{tr("reply.googleCurrent")}</span>
              <p className="whitespace-pre-wrap">{conflict.conflictGoogleComment}</p>
            </blockquote>
          ) : (
            <p>{tr("reply.removedOnGoogle")}</p>
          )}
          <details>
            <summary className="cursor-pointer text-xs">{tr("reply.yourDraft")}</summary>
            <p className="whitespace-pre-wrap">{conflict.body}</p>
          </details>
        </div>
      )}

      {!open && !composing && (
        <div className="flex gap-2">
          {data.review.canDraft && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setBody(conflict ? conflict.body : (googleReply ?? ""));
                setChecked(null);
                setComposing(true);
              }}
            >
              {conflict
                ? tr("reply.newRevision")
                : data.review.hasGoogleReply
                  ? tr("reply.editPublished")
                  : tr("reply.write")}
            </button>
          )}
          {data.review.canDraft && (
            <button type="button" className={small} disabled={busy} onClick={aiDraft}>
              {tr("reply.draftWithAi")}
            </button>
          )}
          {data.review.canDeletePublished && (
            <button type="button" className={danger} disabled={busy} onClick={remove}>
              {tr("reply.deleteReply")}
            </button>
          )}
        </div>
      )}

      {(open || composing) && (
        <>
          {open && (
            <p className="text-[13px] font-semibold text-muted-foreground">
              {tr("reply.revision", { n: open.revision })} <strong className="text-foreground">{status}</strong>
              {open.publishPending ? ` ${tr("reply.publishing")}` : ""}
              {open.status === "draft" && open.rejectReason
                ? ` ${tr("reply.rejected", { reason: open.rejectReason })}`
                : ""}
              {open.failureReason ? ` (${failureLabel(open.failureReason)})` : ""}
            </p>
          )}
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            {tr("reply.replyText")}
            <textarea
              className="min-h-28 rounded-lg border border-input bg-card px-3 py-2 text-sm font-normal leading-[22px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              value={body}
              disabled={busy || (open !== null && !open.can.edit)}
              onChange={(e) => {
                setBody(e.target.value);
                setChecked(null);
              }}
            />
          </label>
          {(open === null || open.can.edit) && data.review.canDraft && (
            <button type="button" className={`${small} self-start`} disabled={busy} onClick={aiDraft}>
              {tr("reply.draftWithAi")}
            </button>
          )}
          {templates.length > 0 && (open === null || open.can.edit) && (
            <label className="flex items-center gap-2 text-[13px] font-semibold">
              {tr("reply.insertTemplate")}
              <select
                className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                value=""
                disabled={busy}
                onChange={(e) => insertTemplate(e.target.value)}
              >
                <option value="">{tr("reply.chooseTemplate")}</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} disabled={!t.allowed}>
                    {t.name}
                    {t.allowed ? "" : ` ${tr("reply.notAllowed")}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {shown && <Violations result={shown} />}
          {hasWarnings && (open === null || open.can.submit || open.can.publish) && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              {tr("reply.acknowledge")}
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <button
              type="button"
              className={small}
              disabled={busy || body.trim() === ""}
              onClick={check}
            >
              {tr("reply.check")}
            </button>
            {(open === null || open.can.edit) && (
              <button
                type="button"
                className={small}
                disabled={busy || body.trim() === "" || (open !== null && !dirty)}
                onClick={saveDraft}
              >
                {tr("reply.saveDraft")}
              </button>
            )}
            {open?.can.submit && (
              <button type="button" className={buttonClass} disabled={busy} onClick={submit}>
                {tr("reply.submit")}
              </button>
            )}
            {open?.can.approve && (
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => act(() => reviewReplies_approve({ id: open.id }))}
              >
                {tr("reply.approve")}
              </button>
            )}
            {open?.can.reject && (
              <>
                <input
                  aria-label={tr("reply.rejectReason")}
                  placeholder={tr("reply.rejectPlaceholder")}
                  className="h-9 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
                <button
                  type="button"
                  className={small}
                  disabled={busy || rejectReason.trim() === ""}
                  onClick={() =>
                    act(() => reviewReplies_reject({ id: open.id, reason: rejectReason }))
                  }
                >
                  {tr("reply.sendBack")}
                </button>
              </>
            )}
            {open?.can.publish && !open.publishPending && (
              <button type="button" className={buttonClass} disabled={busy} onClick={publish}>
                {open.status === "failed" ? tr("reply.retryPublish") : tr("reply.publish")}
              </button>
            )}
            {composing && !open && (
              <button
                type="button"
                className="inline-flex min-h-9 items-center px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => setComposing(false)}
              >
                {tr("reply.cancel")}
              </button>
            )}
          </div>
        </>
      )}
      <ErrorText message={error} />
      {note && (
        <p
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${NOTE_TONE[note.tone]}`}
          aria-live="polite"
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
