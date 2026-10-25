"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { PostLanguage } from "@opengmb/core";
import {
  posts_check,
  posts_createDraft,
  posts_submit,
  posts_updateDraft,
} from "../app/_generated/actions";
import {
  CTA_OPTIONS,
  NOTES,
  ctaOptionLabel,
  POST_TYPES,
  checkBadge,
  counter,
  ctaHint,
  editingLine,
  initialForm,
  languageGroups,
  packsLine,
  selectedText,
  sendTimeInstant,
  sendTimeProblem,
  sentBackLine,
  toContent,
  type ComposeForm,
  type NoteKey,
} from "../lib/posts";
import { approvalsHref } from "../lib/approvals";
import { ProvenanceChip } from "./approvals/provenance-chip";
import { SchedulePicker } from "./schedule-picker";
import { useTimeFormat } from "./time-format-provider";
import { AiPostPanel } from "./posts/ai-post-panel";
import { PostImageField } from "./posts/post-image-field";
import { PostPreview } from "./posts/post-preview";
import { runCall, type PostData } from "./post-card";
import { Violations, type GuardrailResult } from "./reply-panel";
import { buttonClass, ErrorText, inputClass, linkClass, secondaryButtonClass } from "./ui";

const fieldLabel = "flex flex-col gap-1.5 text-[13px] font-semibold text-foreground";
const hint = "text-xs text-muted-foreground";
const smallButton =
  "inline-flex h-[30px] items-center rounded-control border border-input bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const NOTE_CLASS = {
  good: "bg-good-bg text-good",
  bad: "bg-bad-bg text-bad",
  warn: "bg-warn-bg text-warn",
  info: "bg-info-bg text-info",
} as const;

export type ComposerLocation = { id: string; title: string };

/**
 * Post editor for one workspace. posts.check runs ~500ms after each change; saving never needs a
 * clean check, submitting runs the real guardrails server-side. Fields the chosen type hides are
 * never sent (lib/posts.ts toContent).
 */
export function PostComposer({
  workspaceId,
  workspaceName,
  locations,
  languages,
  defaultLanguage,
  maxChars,
  maxImageBytes,
  prefill,
  post,
}: {
  workspaceId: string;
  workspaceName: string;
  locations: ComposerLocation[];
  languages: readonly { code: PostLanguage; label: string }[];
  defaultLanguage: PostLanguage;
  maxChars: number;
  maxImageBytes: number;
  /** Starting values for a new post (a template or a library image); ignored when editing. */
  prefill?: Partial<ComposeForm>;
  post?: PostData;
}) {
  const router = useRouter();
  const tp = useTranslations("posts");
  const zone = useTimeFormat().zone(workspaceId);
  const [form, setForm] = useState<ComposeForm>(() => ({
    ...initialForm(post, defaultLanguage, zone),
    ...(post ? {} : prefill),
  }));
  const [locationIds, setLocationIds] = useState(() => [
    ...new Set(post?.targets.map((t) => t.locationId) ?? []),
  ]);
  const [postId, setPostId] = useState(post?.id ?? null);
  const [status, setStatus] = useState<string | null>(post?.status ?? null);
  const [checked, setChecked] = useState<GuardrailResult | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<NoteKey | null>(null);

  const set = <K extends keyof ComposeForm>(k: K, v: ComposeForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const submitted = status === "pending_approval";
  const locked = busy || submitted;
  const count = counter(form.summary, maxChars);
  const badge = checked ? checkBadge(tp, checked) : null;
  const hasWarnings = (checked?.violations ?? []).some((v) => v.severity === "warn");
  const t = form.topicType;
  const dated = t === "EVENT" || t === "OFFER";
  const { main, other } = languageGroups(languages);
  const titles = locations.filter((l) => locationIds.includes(l.id)).map((l) => l.title);

  // Live check, ~500ms after the last change. The key carries everything the check reads.
  const key = JSON.stringify([toContent(form), locationIds]);
  useEffect(() => {
    let stale = false;
    const [content, ids] = JSON.parse(key) as [ReturnType<typeof toContent>, string[]];
    const timer = setTimeout(async () => {
      const r = await runCall<GuardrailResult>(() =>
        posts_check({ workspaceId, ...content, ...(ids.length ? { locationIds: ids } : {}) }),
      );
      if (stale) return;
      if ("error" in r) setError(r.error);
      else setChecked(r.data);
    }, 500);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [key, workspaceId]);

  /** Create the draft, or update it once it exists; returns the saved post. */
  async function save(): Promise<PostData | null> {
    const timeProblem = sendTimeProblem(tp, form.sendAt, zone);
    if (timeProblem) {
      setError(timeProblem);
      return null;
    }
    const scheduledFor = sendTimeInstant(form.sendAt, zone);
    // An update sends null to clear a time saved earlier; a new post just has none.
    const body = {
      ...toContent(form),
      language: form.language,
      locationIds,
      ...(scheduledFor || postId ? { scheduledFor } : {}),
    };
    const r = await runCall<{ post: PostData }>(() =>
      postId
        ? posts_updateDraft({ id: postId, ...body })
        : posts_createDraft({ workspaceId, ...body }),
    );
    if ("error" in r) {
      setError(r.error);
      return null;
    }
    setPostId(r.data.post.id);
    setStatus(r.data.post.status);
    return r.data.post;
  }

  async function saveDraft() {
    setBusy(true);
    setError(null);
    setNote(null);
    if (await save()) setNote("saved");
    setBusy(false);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setNote(null);
    const saved = await save();
    if (saved) {
      const r = await runCall<{ outcome: string; post: PostData; result: GuardrailResult }>(() =>
        posts_submit({ id: saved.id, acknowledgeWarnings: ack }),
      );
      if ("error" in r) setError(r.error);
      else {
        setChecked(r.data.result);
        setStatus(r.data.post.status);
        if (r.data.outcome === "blocked") setNote("blocked");
        else if (r.data.outcome === "needs_acknowledgement") setNote("ack");
        else {
          setNote("submitted");
          router.refresh();
        }
      }
    }
    setBusy(false);
  }

  const noteShown = note ? NOTES[note] : null;
  return (
    <div className="flex flex-wrap items-start gap-5">
      <form
        aria-label={postId ? tp("comp.editForm") : tp("comp.newForm")}
        onSubmit={(e) => e.preventDefault()}
        className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 rounded-panel border border-border bg-card p-5 shadow-card"
      >
        {status && <p className="text-sm text-muted-foreground">{editingLine(tp, status)}</p>}
        {post?.createdSurface === "mcp" && (
          <div className="flex flex-wrap items-center gap-2">
            <ProvenanceChip surface="mcp" name={null} />
            <span className={hint}>{tp("comp.checkRerun")}</span>
          </div>
        )}
        {status === "draft" && post?.rejectReason && (
          <p className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
            {sentBackLine(tp, post.rejectedByName, post.rejectReason)}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          {/* Plan 2C adds "Start from a template" before this field. */}
          <label className={`${fieldLabel} flex-[1_1_200px]`}>
            {tp("comp.language")}
            <select
              className={inputClass}
              value={form.language}
              disabled={locked}
              onChange={(e) => set("language", e.target.value as PostLanguage)}
            >
              {main.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
              <optgroup label={tp("comp.otherLanguages")}>
                {other.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-foreground">{tp("common.postType")}</span>
          <div
            role="tablist"
            aria-label={tp("common.postType")}
            className="flex flex-wrap gap-0.5 self-start rounded-[11px] bg-secondary p-[3px]"
          >
            {POST_TYPES.map((pt) => (
              <button
                key={pt.key}
                type="button"
                role="tab"
                aria-selected={t === pt.key}
                disabled={locked}
                onClick={() => set("topicType", pt.key)}
                className={`h-9 rounded-lg px-3.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring ${
                  t === pt.key ? "bg-card font-bold shadow-card" : "font-medium"
                }`}
              >
                {tp(`type.${pt.key}`)}
              </button>
            ))}
          </div>
        </div>

        {t === "ALERT" && (
          <div className="flex flex-col gap-2">
            <label className={fieldLabel}>
              {tp("comp.alertType")}
              <select className={inputClass} value="COVID_19" disabled>
                <option value="COVID_19">COVID-19 (COVID_19)</option>
              </select>
            </label>
            <p
              role="note"
              className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn"
            >
              {tp("comp.alertCovid")}
            </p>
          </div>
        )}

        <label className={fieldLabel}>
          {tp("comp.summary")}
          <textarea
            rows={6}
            className={`${inputClass} font-normal leading-[22px] ${count.over ? "border-bad" : ""}`}
            value={form.summary}
            disabled={locked}
            onChange={(e) => set("summary", e.target.value)}
          />
        </label>
        <div className="-mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {tp("comp.noPhone")}
          </span>
          <span
            aria-live="polite"
            className={`font-semibold tabular-nums ${count.over ? "text-bad" : "text-foreground"}`}
          >
            {count.text}
          </span>
        </div>

        {!post && (
          <AiPostPanel
            workspaceId={workspaceId}
            locations={locations}
            locationIds={locationIds}
            disabled={locked}
            hasText={form.summary.trim() !== ""}
            onWrite={(text) => setForm((f) => ({ ...f, topicType: "STANDARD", summary: text }))}
          />
        )}

        {dated && (
          <fieldset className="grid gap-3 rounded-panel border border-border p-3.5 sm:grid-cols-2">
            <legend className="px-1.5 text-[13px] font-semibold text-foreground">
              {t === "OFFER" ? tp("comp.offer") : tp("comp.event")}
            </legend>
            <label className={`${fieldLabel} sm:col-span-2`}>
              {tp("comp.title")}
              <input
                className={inputClass}
                value={form.title}
                disabled={locked}
                onChange={(e) => set("title", e.target.value)}
              />
            </label>
            <label className={fieldLabel}>
              {tp("comp.startDate")}
              <input
                type="date"
                className={inputClass}
                value={form.startDate}
                disabled={locked}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </label>
            <label className={fieldLabel}>
              {tp("comp.startTime")}
              <input
                type="time"
                className={inputClass}
                value={form.startTime}
                disabled={locked}
                onChange={(e) => set("startTime", e.target.value)}
              />
            </label>
            <label className={fieldLabel}>
              {tp("comp.endDate")}
              <input
                type="date"
                className={inputClass}
                value={form.endDate}
                disabled={locked}
                onChange={(e) => set("endDate", e.target.value)}
              />
            </label>
            <label className={fieldLabel}>
              {tp("comp.endTime")}
              <input
                type="time"
                className={inputClass}
                value={form.endTime}
                disabled={locked}
                onChange={(e) => set("endTime", e.target.value)}
              />
            </label>
            <span className={`${hint} sm:col-span-2`}>
              {tp("comp.timesHint")}
            </span>
            {t === "OFFER" && (
              <>
                <label className={fieldLabel}>
                  {tp("common.couponCode")}
                  <input
                    className={inputClass}
                    value={form.couponCode}
                    disabled={locked}
                    onChange={(e) => set("couponCode", e.target.value)}
                  />
                </label>
                <label className={fieldLabel}>
                  {tp("common.redeemUrl")}
                  <input
                    type="url"
                    className={inputClass}
                    value={form.redeemOnlineUrl}
                    disabled={locked}
                    onChange={(e) => set("redeemOnlineUrl", e.target.value)}
                  />
                </label>
                <label className={`${fieldLabel} sm:col-span-2`}>
                  {tp("common.terms")}
                  <textarea
                    rows={2}
                    className={inputClass}
                    value={form.termsConditions}
                    disabled={locked}
                    onChange={(e) => set("termsConditions", e.target.value)}
                  />
                </label>
              </>
            )}
          </fieldset>
        )}

        <div className="flex flex-wrap gap-3">
          <label className={`${fieldLabel} flex-[1_1_200px]`}>
            {tp("common.callToAction")}
            <select
              className={inputClass}
              value={form.ctaType}
              disabled={locked}
              onChange={(e) => set("ctaType", e.target.value)}
            >
              {CTA_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {ctaOptionLabel(tp, o.value)}
                </option>
              ))}
            </select>
          </label>
          {form.ctaType !== "none" && form.ctaType !== "CALL" && (
            <label className={`${fieldLabel} flex-[2_1_280px]`}>
              {tp("common.buttonUrl")}
              <input
                type="url"
                className={inputClass}
                value={form.ctaUrl}
                disabled={locked}
                onChange={(e) => set("ctaUrl", e.target.value)}
              />
            </label>
          )}
        </div>
        <span className={`-mt-2 ${hint}`}>{ctaHint(tp, form.ctaType)}</span>
        {t === "OFFER" && (
          <span className={hint}>
            {tp("comp.offerCtaNote")}
          </span>
        )}

        {t === "ALERT" ? (
          <p className={hint}>
            {tp("comp.alertHidden")}
          </p>
        ) : (
          <PostImageField
            workspaceId={workspaceId}
            value={form.image?.sourceUrl ?? ""}
            onChange={(url) => set("image", url ? { sourceUrl: url } : null)}
            locationNames={titles}
            maxBytes={maxImageBytes}
            disabled={locked}
          />
        )}

        <fieldset className="flex flex-col gap-2.5 rounded-panel border border-border p-3.5">
          <legend className="px-1.5 text-[13px] font-semibold text-foreground">{tp("comp.locations")}</legend>
          <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
            <strong>{selectedText(tp, locationIds.length, locations.length)}</strong>
            <button
              type="button"
              className={smallButton}
              disabled={locked}
              onClick={() => setLocationIds(locations.map((l) => l.id))}
            >
              {tp("comp.selectAll")}
            </button>
            <button
              type="button"
              className={smallButton}
              disabled={locked}
              onClick={() => setLocationIds([])}
            >
              {tp("common.clear")}
            </button>
            <span className="ml-auto text-muted-foreground">
              {tp("comp.ownCopy")}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {locations.map((l) => {
              const on = locationIds.includes(l.id);
              return (
                <label
                  key={l.id}
                  className={`flex min-h-11 items-center gap-2.5 rounded-control border px-3 text-sm font-medium ${
                    on ? "border-brand bg-brand-tint" : "border-border bg-card"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-[18px] accent-primary"
                    checked={on}
                    disabled={locked}
                    onChange={(e) =>
                      setLocationIds((ids) =>
                        e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id),
                      )
                    }
                  />
                  {l.title}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5 rounded-panel border border-border p-3.5">
          <SchedulePicker
            label={tp("comp.sendTime")}
            value={form.sendAt}
            onChange={(v) => set("sendAt", v)}
            workspaceId={workspaceId}
            disabled={locked}
            clearable
          />
          <span className={hint}>
            {tp("comp.sendTimeHint")}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={locked || locationIds.length === 0}
            onClick={saveDraft}
          >
            {tp("comp.saveDraft")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={locked || locationIds.length === 0}
            onClick={submit}
          >
            {tp("comp.submit")}
          </button>
          {locationIds.length === 0 && !submitted && (
            <span className={hint}>{tp("comp.tickOne")}</span>
          )}
          <Link href={approvalsHref({ tab: "post", ws: workspaceId })} className={`ml-auto ${linkClass}`}>
            {tp("comp.openQueue")}
          </Link>
        </div>
        {noteShown && (
          <p
            role="status"
            className={`rounded-control px-3 py-2 text-sm ${NOTE_CLASS[noteShown.tone]}`}
          >
            {tp(`note.${note}`)}
          </p>
        )}
        <ErrorText message={error} />
      </form>

      <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
        {!submitted && (
          <section
            aria-label={tp("comp.check")}
            className={`flex flex-col gap-2.5 rounded-panel border bg-card p-4 ${
              badge?.tone === "bad" ? "border-bad-border" : "border-border"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-[17px] font-bold text-foreground">{tp("comp.check")}</h2>
              {badge && (
                <span
                  className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-xs font-bold ${
                    badge.tone === "bad" ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn"
                  }`}
                >
                  {badge.text}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{tp("comp.checkedAsYouType")}</span>
            </div>
            {checked ? (
              <Violations result={checked} showMatches />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {tp("comp.checking")}
              </p>
            )}
            {checked && <p className={hint}>{packsLine(tp, checked.packs, workspaceName)}</p>}
            {hasWarnings && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={locked}
                  onChange={(e) => setAck(e.target.checked)}
                />
                {tp("common.ackWarnings")}
              </label>
            )}
          </section>
        )}
        <PostPreview workspaceName={workspaceName} locationTitles={titles} form={form} />
        <div className="flex items-start gap-3 rounded-panel border border-agent-border bg-agent-bg px-3.5 py-3 text-[13px] text-agent">
          <span className="flex-1">
            {tp.rich("comp.agentTip", {
              link: (chunks) => (
                <Link href="/agents" className="font-bold underline underline-offset-2">
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </div>
      </aside>
    </div>
  );
}
