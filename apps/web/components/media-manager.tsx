"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { mediaCustomerList, mediaList } from "@opengmb/core";
import { media_add, media_batch, media_cancelScheduled, media_delete, media_list } from "../app/_generated/actions";
import { failureLabel } from "../lib/failure-labels";
import { isMissingTimestamp } from "../lib/labels";
import {
  categoryChip,
  categoryPills,
  failureLine,
  filterKey,
  filterPhotos,
  openOps,
  opSettlement,
  opTone,
  photoActions,
  sizeLabel,
  sortPhotos,
  type SortOrder,
} from "../lib/photos";
import { AgentProposalNote } from "./agent-proposal-note";
import { PhotoUpload, type UploadLimits } from "./photo-upload";
import { EmptyNext } from "./empty-next";
import { runCall } from "./post-card";
import { useTimeFormat } from "./time-format-provider";
import { buttonClass, ErrorText, inputClass, Panel, secondaryButtonClass } from "./ui";

type Listed = Awaited<ReturnType<(typeof mediaList)["handler"]>>;
export type MediaItem = Listed["items"][number];
export type MediaOp = Listed["operations"][number];
export type CustomerItem = Awaited<ReturnType<(typeof mediaCustomerList)["handler"]>>["items"][number];

const POLL_MS = 1500;
const POLL_TRIES = 40;

/** Poll media.list until the operation settles. null = applied; otherwise a `code: label` line. */
async function settle(locationId: string, opId: string, stillWorking: string, cancelledNote: string): Promise<string | null> {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const r = await runCall<Listed>(() => media_list({ locationId }));
    if ("error" in r) return r.error;
    const op = r.data.operations.find((o) => o.id === opId);
    switch (opSettlement(op)) {
      case "failed":
        return failureLine(op?.error ?? "failed");
      case "cancelled":
        return cancelledNote;
      case "applied":
      case "scheduled": // waiting for its time: nothing more to poll for
        return null;
      case "working":
        break;
    }
  }
  return stillWorking;
}

const OP_TONE = {
  info: "border-info-border bg-info-bg text-info",
  bad: "border-bad-border bg-bad-bg text-bad",
  good: "border-good-border bg-good-bg text-good",
} as const;
const small = `${secondaryButtonClass} min-h-8 px-2.5 text-xs`;
const chip = "inline-flex h-5 items-center rounded-full bg-secondary px-2 text-[11px] font-bold text-secondary-foreground";

/* Google-hosted image URLs (lh3...) are not static, so next/image's remote allow list does not fit. */
/* eslint-disable @next/next/no-img-element */
export function MediaManager({
  locationId,
  canEdit,
  writesOff,
  categories,
  uploadLimits,
  items,
  operations,
  customer,
  customerError,
  siblings,
  workspaceId,
}: {
  locationId: string;
  siblings: { id: string; name: string }[];
  workspaceId: string;
  canEdit: boolean;
  writesOff: boolean;
  categories: readonly string[];
  uploadLimits: UploadLimits;
  items: MediaItem[];
  operations: MediaOp[];
  customer: CustomerItem[];
  customerError: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("locationHub.media");
  const tf = useTimeFormat();
  const [filter, setFilter] = useState("all");
  const [order, setOrder] = useState<SortOrder>("newest");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("ADDITIONAL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  async function cancelScheduled(opId: string) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ cancelled: boolean }>(() => media_cancelScheduled({ workspaceId, opId }));
    setBusy(false);
    setConfirmCancel(null);
    if ("error" in r) setError(r.error);
    else if (!r.data.cancelled) setError(t("alreadySent"));
    router.refresh();
  }

  async function queue(fn: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ operation: MediaOp }>(fn as never);
    if ("error" in r) {
      setBusy(false);
      return setError(r.error);
    }
    const problem = await settle(locationId, r.data.operation.id, t("stillWorking"), t("cancelledNote"));
    setBusy(false);
    if (problem) setError(problem);
    router.refresh();
  }

  const sourceOf = (m: MediaItem) => m.sourceUrl ?? m.googleUrl ?? "";
  const catLabel = (c: string | null) => (c === null ? t("noCategory") : t.has(`cat.${c}`) ? t(`cat.${c}`) : categoryChip(c));
  const pillName = (k: string) => (k === "NONE" ? t("noCategory") : t.has(`pill.${k}`) ? t(`pill.${k}`) : catLabel(k));
  const opLine = (o: MediaOp) => {
    const cat =
      o.kind === "delete"
        ? items.find((i) => i.name === o.payload.mediaName)?.category
        : (o.payload.category as string | null | undefined);
    const what = cat ? t("opPhotoOf", { category: catLabel(cat).toLowerCase() }) : t("opPhoto");
    const status =
      o.status === "scheduled" && o.scheduledFor
        ? t("opScheduledFor", { at: tf.dateTime(o.scheduledFor, workspaceId) })
        : t(`opStatus.${o.status === "pending" ? "queued" : o.status}`);
    return `${t(o.kind === "delete" ? "opLineRemove" : "opLineAdd", { what, status })}${o.error ? ` (${failureLabel(o.error)})` : ""}`;
  };
  const pills = categoryPills(items);
  const shown = sortPhotos(filterPhotos(items, filter), order);
  const pending = openOps(operations);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold">{t("photosTitle", { count: items.length })}</h2>
          <label className="flex items-center gap-2 text-sm font-medium">
            {t("sort")}
            <select value={order} onChange={(e) => setOrder(e.target.value as SortOrder)} className={inputClass}>
              <option value="newest">{t("newest")}</option>
              <option value="oldest">{t("oldest")}</option>
            </select>
          </label>
        </div>
        <div role="group" aria-label={t("filterAria")} className="flex flex-wrap gap-2">
          {pills.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={filter === p.key}
              onClick={() => setFilter(p.key)}
              className={`rounded-full border px-3 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                filter === p.key ? "border-brand/40 bg-brand-tint font-bold" : "border-input bg-card font-medium"
              }`}
            >
              {p.key === "all" ? t("pillAll", { count: items.length }) : t("pillCount", { label: pillName(p.key), count: items.filter((m) => filterKey(m.category) === p.key).length })}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <EmptyNext id="photos" noLink={!canEdit} ask={t("addPhotosHint")} />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {shown.map((m) => {
              const can = photoActions(m);
              const thumb = m.thumbnailUrl ?? m.googleUrl;
              return (
                <li key={m.name} className="flex flex-col gap-1.5 rounded-control border border-border bg-card p-2">
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={`${catLabel(m.category)}${m.description ? `: ${m.description}` : ""}`}
                      className="aspect-[4/3] w-full rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div role="img" aria-label={catLabel(m.category)} className="flex aspect-[4/3] items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                      {t("noPreview")}
                    </div>
                  )}
                  <span className={chip}>{catLabel(m.category)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {[sizeLabel(m.widthPixels, m.heightPixels), isMissingTimestamp(m.createTime) ? "" : t("added", { date: tf.date(m.createTime!) })].filter(Boolean).join(" · ")}
                  </span>
                  {canEdit && (
                    <div className="flex flex-wrap gap-1">
                      {can.cover && (
                        <button type="button" className={small} disabled={busy}
                          onClick={() => queue(() => media_add({ locationId, sourceUrl: sourceOf(m), category: "COVER" }))}>
                          {t("setCover")}
                        </button>
                      )}
                      {can.logo && (
                        <button type="button" className={small} disabled={busy}
                          onClick={() => queue(() => media_add({ locationId, sourceUrl: sourceOf(m), category: "PROFILE" }))}>
                          {t("setLogo")}
                        </button>
                      )}
                      {can.remove && (
                        <button type="button" disabled={busy}
                          className="inline-flex min-h-8 items-center rounded-control border border-bad-border bg-bad-bg px-2.5 text-xs font-semibold text-bad disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          onClick={() => {
                            if (window.confirm(t("deleteConfirm")))
                              void queue(() => media_delete({ locationId, mediaName: m.name }));
                          }}>
                          {t("delete")}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && items.length > 0 && <span className="text-xs text-muted-foreground">{t("deleteNote")}</span>}
        {!canEdit && <p className="text-sm text-muted-foreground">{t("viewOnly")}</p>}
        <ErrorText message={error} />

        {pending.length > 0 && (
          <section aria-label={t("pending")} className="flex flex-col gap-2">
            <h2 className="font-display text-base font-bold">{t("pending")}</h2>
            <ul className="flex flex-col gap-1.5">
              {pending.map((o) => (
                <li key={o.id} className={`rounded-control border px-3 py-1.5 text-[13px] ${OP_TONE[opTone(o)]}`}>
                  <span>{opLine(o)}</span>
                  {canEdit && o.status === "scheduled" &&
                    (confirmCancel === o.id ? (
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium">{t("cancelConfirm")}</span>
                        <button type="button" className={small} disabled={busy} onClick={() => void cancelScheduled(o.id)}>
                          {t("cancelYes")}
                        </button>
                        <button type="button" className={small} disabled={busy} onClick={() => setConfirmCancel(null)}>
                          {t("cancelKeep")}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className={`${small} mt-1 block`} disabled={busy} onClick={() => setConfirmCancel(o.id)}>
                        {t("cancel")}
                      </button>
                    ))}
                  {o.error && failureLabel(o.error) !== o.error && <span className="block text-xs">{failureLabel(o.error)}.</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label={t("customerAria")} className="flex flex-col gap-2">
          <h2 className="font-display text-base font-bold">{t("customerTitle", { count: customer.length })}</h2>
          {customerError ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-[13px] text-bad">
                {t.rich("customerError", {
                  c: (chunks) => <span className="font-mono">{chunks}</span>,
                  code: customerError.split(":")[0] ?? "",
                  rest: customerError.slice(customerError.indexOf(":") + 1),
                })}
              </p>
              <Link href="/settings/google" className="text-sm font-semibold text-brand-text underline underline-offset-2">{t("openSettings")}</Link>
            </div>
          ) : customer.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("customerNone")}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {customer.map((m) => (
                <li key={m.name} className="flex flex-col gap-1 rounded-control border border-border bg-card p-2">
                  {m.thumbnailUrl || m.googleUrl ? (
                    <img src={m.thumbnailUrl ?? m.googleUrl ?? ""} alt={t("customerAlt")} className="aspect-[4/3] w-full rounded-md object-cover" loading="lazy" />
                  ) : null}
                  {m.attribution && (
                    <span className="flex flex-wrap gap-x-3 text-xs">
                      {m.attribution.profileUrl ? (
                        <a href={m.attribution.profileUrl} className="text-brand-text underline" rel="noreferrer">
                          {t("by", { name: m.attribution.profileName ?? t("googleUser") })}
                        </a>
                      ) : (
                        <span>{t("by", { name: m.attribution.profileName ?? t("googleUser") })}</span>
                      )}
                      {m.attribution.takedownUrl && (
                        <a href={m.attribution.takedownUrl} className="text-brand-text underline" rel="noreferrer">{t("report")}</a>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <span className="text-xs text-muted-foreground">{t("attribution")}</span>
        </section>
      </div>

      {canEdit && (
        <aside id="add-photo" aria-label={t("addAria")} className="flex flex-col gap-4">
          {writesOff && (
            <p role="status" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
              {t.rich("writesOff", { b: (chunks) => <strong>{chunks}</strong> })}
            </p>
          )}
          <Panel title={t("uploadPanel")}>
            <PhotoUpload
              locationId={locationId}
              categories={categories}
              limits={uploadLimits}
              settle={(opId) => settle(locationId, opId, t("stillWorking"), t("cancelledNote"))}
              onDone={() => router.refresh()}
              siblings={siblings}
              timeZone={tf.zone(workspaceId)}
              pollBatch={async (batchId) => {
                const r = await runCall<{ items: { locationId: string; operation: MediaOp }[] }>(() => media_batch({ workspaceId, batchId }));
                if ("error" in r) return null;
                return r.data.items.map((i) => ({ locationId: i.locationId, status: i.operation.status, error: i.operation.error }));
              }}
            />
          </Panel>
          <Panel title={t("urlPanel")}>
            <form
              className="flex flex-col gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await queue(() => media_add({ locationId, sourceUrl: url, category }));
                setUrl("");
              }}
            >
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t("imageUrl")}
                <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t("category")}
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
                  {categories.map((c) => (
                    <option key={c} value={c}>{catLabel(c)}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className={`${buttonClass} self-start`} disabled={busy}>
                {busy ? t("working") : t("addPhoto")}
              </button>
            </form>
          </Panel>
          <AgentProposalNote what="photo uploads, additions and deletes" />
        </aside>
      )}
    </div>
  );
}
