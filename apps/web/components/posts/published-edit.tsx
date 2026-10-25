"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { postsEditGet } from "@opengmb/core";
import {
  posts_approveEdit,
  posts_cancelEdit,
  posts_editGet,
  posts_proposeEdit,
  posts_rejectEdit,
} from "../../app/_generated/actions";
import { failureLabel } from "../../lib/failure-labels";
import { CTA_OPTIONS, ctaHint, ctaOptionLabel } from "../../lib/posts";
import { Violations, type GuardrailResult } from "../reply-panel";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import type { ActionResult, PostData } from "../post-card";

type Loaded = Awaited<ReturnType<(typeof postsEditGet)["handler"]>>;

const POLL_MS = 1500;
const POLL_TRIES = 40;

async function call<T>(fn: () => Promise<ActionResult>): Promise<{ data: T } | { error: string }> {
  const r = await fn();
  return r.ok ? { data: r.data as T } : { error: `${r.error.code}: ${r.error.message}` };
}

/**
 * Edit a post that is already live on Google. The change is a proposal: it waits for an approver
 * (posts.approveEdit) and only then is sent to Google. The text and the button can be changed here;
 * the image, event and offer can be changed through the API.
 */
export function PublishedEdit({ post, writesOff }: { post: PostData; writesOff: boolean }) {
  const t = useTranslations("posts");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(post.summary);
  const [ctaType, setCtaType] = useState(post.cta?.actionType ?? "none");
  const [ctaUrl, setCtaUrl] = useState(post.cta?.url ?? "");
  const [ack, setAck] = useState(false);
  const [found, setFound] = useState<GuardrailResult | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await call<Loaded>(() => posts_editGet({ id: post.id }));
    if ("data" in r) {
      setLoaded(r.data);
      return r.data;
    }
    return null;
  }, [post.id]);

  useEffect(() => {
    let stale = false;
    void (async () => {
      let cur = await refresh();
      for (let i = 0; !stale && cur?.edit?.status === "applying" && i < POLL_TRIES; i++) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        if (!stale) cur = await refresh();
      }
    })();
    return () => {
      stale = true;
    };
  }, [refresh]);

  async function act<T>(fn: () => Promise<ActionResult>, after?: (d: T) => void) {
    setBusy(true);
    setError(null);
    const r = await call<T>(fn);
    if ("error" in r) setError(r.error);
    else after?.(r.data);
    await refresh();
    setBusy(false);
  }

  async function propose() {
    const changeCta = ctaType !== (post.cta?.actionType ?? "none") || (ctaType !== "none" && ctaType !== "CALL" && ctaUrl !== (post.cta?.url ?? ""));
    await act<{ outcome: string; result: GuardrailResult }>(
      () =>
        posts_proposeEdit({
          id: post.id,
          acknowledgeWarnings: ack,
          ...(summary !== post.summary ? { summary } : {}),
          ...(changeCta
            ? {
                cta:
                  ctaType === "none"
                    ? null
                    : { actionType: ctaType, ...(ctaType === "CALL" ? {} : { url: ctaUrl }) },
              }
            : {}),
        }),
      (d) => {
        setFound(d.result);
        if (d.outcome === "pending_approval") {
          setOpen(false);
          setFound(null);
          setAck(false);
        }
      },
    );
  }

  const edit = loaded?.edit ?? null;
  const live = edit && (edit.status === "pending_approval" || edit.status === "applying");

  return (
    <section aria-label={t("edit.section")} className="flex flex-col gap-2 text-sm">
      {edit && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2">
          <p className="font-medium">
            {t("edit.titleLine", {
              title: live ? t("edit.liveEdit") : t("edit.lastEdit"),
              fields: edit.changedFields.map((f) => (t.has(`edit.field.${f}`) ? t(`edit.field.${f}`) : f)).join(", "),
            })}
          </p>
          <p role="status" className="text-[13px]">
            {t(`edit.status.${edit.status}`)}
            {edit.status === "rejected" && edit.rejectReason ? ` ${edit.rejectReason}` : ""}
          </p>
          {edit.changedFields.includes("summary") && (
            <p className="whitespace-pre-wrap rounded-md border border-border bg-card px-2 py-1">
              {edit.summary || t("common.noText")}
            </p>
          )}
          {edit.results.length > 0 && (
            <ul className="text-[13px]">
              {edit.results.map((r) => (
                <li key={r.targetId}>
                  {t("edit.resultLine", {
                    location: r.locationName || t("edit.locationFallback"),
                    result: r.status === "applied" ? t("edit.changed") : t("edit.notChanged", { reason: r.error ? failureLabel(r.error) : t("edit.failedFallback") }),
                  })}
                </li>
              ))}
            </ul>
          )}
          {edit.guardrail && edit.guardrail.violations.length > 0 && <Violations result={edit.guardrail} />}
          {edit.can.approve && (
            <div className="flex flex-wrap items-end gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => act(() => posts_approveEdit({ id: edit.id }))}
              >
                {t("edit.approveEdit")}
              </button>
              <label className="flex min-w-48 flex-1 flex-col gap-1">
                {t("common.rejectReason")}
                <input
                  className={inputClass}
                  value={reason}
                  placeholder={t("common.rejectPlaceholder")}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy || reason.trim() === ""}
                onClick={() => act(() => posts_rejectEdit({ id: edit.id, reason }))}
              >
                {t("edit.rejectEdit")}
              </button>
            </div>
          )}
          {edit.can.cancel && (
            <div>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy}
                onClick={() => act(() => posts_cancelEdit({ id: edit.id }))}
              >
                {t("edit.withdraw")}
              </button>
            </div>
          )}
        </div>
      )}

      {loaded?.canPropose && !open && (
        <div>
          <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
            {t("edit.open")}
          </button>
        </div>
      )}
      {open && (
        <form
          aria-label={t("edit.formAria")}
          onSubmit={(e) => e.preventDefault()}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <p className="text-[13px] text-muted-foreground">
            {t("edit.intro")}
            {writesOff ? ` ${t("edit.introWritesOff")}` : ""}
          </p>
          <label className="flex flex-col gap-1">
            {t("common.postText")}
            <textarea
              className={`${inputClass} min-h-28`}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1">
              {t("common.callToAction")}
              <select className={inputClass} value={ctaType} onChange={(e) => setCtaType(e.target.value)}>
                {CTA_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {ctaOptionLabel(t, o.value)}
                  </option>
                ))}
              </select>
            </label>
            {ctaType !== "none" && ctaType !== "CALL" && (
              <label className="flex min-w-48 flex-1 flex-col gap-1">
                {t("common.buttonUrl")}
                <input type="url" className={inputClass} value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} />
              </label>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{ctaHint(t, ctaType)}</span>
          {found && <Violations result={found} />}
          {found && found.ok && found.violations.length > 0 && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t("common.ackWarnings")}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={propose}>
              {t("edit.sendForApproval")}
            </button>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setOpen(false)}>
              {t("common.close")}
            </button>
          </div>
        </form>
      )}
      <ErrorText message={error} />
    </section>
  );
}
