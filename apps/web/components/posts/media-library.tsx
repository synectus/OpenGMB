"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { postImages_delete, postImages_rename } from "../../app/_generated/actions";
import {
  deleteReason, filterImages, sizeLabel, usedInLabel, usageLabel,
  type LibraryImage, type LibraryView,
} from "../../lib/post-images";
import { runCall } from "../post-card";
import { buttonClass, destructiveButtonClass, EmptyState, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { useTimeFormat } from "../time-format-provider";
import { BrandedImageDialog } from "./branded-image-dialog";
import { useImageUpload } from "./use-image-upload";

export function MediaLibrary({
  workspaceId, workspaceName, images, canManage, maxBytes, hasLogo,
}: {
  workspaceId: string;
  workspaceName: string;
  images: LibraryImage[];
  canManage: boolean;
  maxBytes: number;
  hasLogo: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("posts");
  const tf = useTimeFormat();
  const [view, setView] = useState<LibraryView>({ show: "all", q: "", sort: "newest" });
  const [selectedId, setSelectedId] = useState<string | null>(images[0]?.id ?? null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [brandedOpen, setBrandedOpen] = useState(false);
  const upload = useImageUpload(workspaceId, maxBytes, (img) => {
    setSelectedId(img.id);
    router.refresh();
  });

  const shown = filterImages(images, view);
  const selected = images.find((i) => i.id === selectedId) ?? null;
  const usedCount = images.filter((i) => i.usedIn.length > 0).length;
  const pill = (show: LibraryView["show"], label: string, n: number) => (
    <button key={show} type="button" aria-pressed={view.show === show}
      onClick={() => setView({ ...view, show })}
      className={`h-8 rounded-control px-2.5 text-sm ${view.show === show ? "bg-card font-semibold shadow-card" : "text-muted-foreground"}`}>
      {label} {n}
    </button>
  );

  async function rename() {
    if (!selected || name === null || name.trim() === selected.name) return;
    const r = await runCall(() => postImages_rename({ id: selected.id, name }));
    if ("error" in r) return setError(r.error);
    setError(null);
    setName(null);
    router.refresh();
  }
  async function remove() {
    if (!selected) return;
    const drafts = selected.usedIn.length;
    const ok = window.confirm(
      drafts > 0 ? t("media.confirmDeleteUsed", { count: drafts }) : t("media.confirmDelete"),
    );
    if (!ok) return;
    const r = await runCall(() => postImages_delete({ id: selected.id }));
    if ("error" in r) return setError(r.error);
    setError(null);
    setSelectedId(null);
    router.refresh();
  }

  return (
    <section aria-label={t("media.section")} className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
        {canManage ? (
          <section
            aria-label={t("media.uploadAria")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void upload.addFiles(e.dataTransfer.files); }}
            className={`flex flex-wrap items-center gap-3 rounded-2xl border-2 border-dashed border-input p-4 ${over ? "bg-muted" : "bg-card"}`}
          >
            <div className="flex min-w-60 flex-1 flex-col gap-0.5">
              <strong>{t("media.dropTitle")}</strong>
              <span className="text-sm text-muted-foreground">
                {t("media.dropBody")}
              </span>
            </div>
            <label className={`${buttonClass} cursor-pointer`}>
              {t("common.chooseFiles")}
              <input type="file" multiple accept="image/jpeg,image/png" className="sr-only"
                onChange={(e) => { void upload.addFiles(e.target.files); e.target.value = ""; }} />
            </label>
          </section>
        ) : (
          <p className="rounded-control border border-border bg-muted p-3 text-sm">
            {t("common.needsRole")}
          </p>
        )}

        <form aria-label={t("media.filters")} className="flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
          <div role="group" aria-label={t("media.show")} className="flex rounded-control bg-muted p-0.5">
            {pill("all", t("media.pillAll"), images.length)}
            {pill("used", t("media.pillUsed"), usedCount)}
            {pill("unused", t("media.pillUnused"), images.length - usedCount)}
          </div>
          <input type="search" aria-label={t("common.searchImages")} placeholder={t("common.searchImages")} className={`${inputClass} max-w-xs`}
            value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} />
          <select aria-label={t("media.sort")} className={inputClass + " w-auto"} value={view.sort}
            onChange={(e) => setView({ ...view, sort: e.target.value as LibraryView["sort"] })}>
            <option value="newest">{t("media.sortNewest")}</option>
            <option value="used">{t("media.sortUsed")}</option>
            <option value="name">{t("media.sortName")}</option>
          </select>
          {canManage && images.length > 0 && (
            <button type="button" className={secondaryButtonClass} onClick={() => setBrandedOpen(true)}>{t("branded.open")}</button>
          )}
          <span className="ml-auto text-sm text-muted-foreground">{t("media.sharedBy", { name: workspaceName })}</span>
        </form>

        {images.length === 0 && upload.items.length === 0 ? (
          <EmptyState title={t("common.noImagesTitle")}>
            {t("common.noImagesBody")}
          </EmptyState>
        ) : (
          <ul aria-label={t("media.images")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {upload.items.filter((u) => u.phase !== "done").map((u) => (
              <li key={u.key} className={`overflow-hidden rounded-2xl border ${u.phase === "refused" ? "border-bad-border bg-bad-bg" : "border-border bg-card"}`}>
                <div className="flex h-28 items-center justify-center p-2 text-center text-xs font-semibold text-muted-foreground">
                  {u.phase === "refused" ? t("media.notAdded") : u.name}
                </div>
                <div className="flex flex-col gap-1 p-2.5 text-xs">
                  <strong className="truncate">{u.name}</strong>
                  {u.phase === "uploading" ? (
                    <>
                      <span className="text-muted-foreground">{t("media.uploadingSize", { size: sizeLabel(u.size) })}</span>
                      <div role="progressbar" aria-label={t("common.progress")} aria-valuenow={u.percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-1.5 bg-primary" style={{ width: `${u.percent}%` }} />
                      </div>
                      <span className="font-semibold">{t("media.uploadingPct", { percent: u.percent })}</span>
                      <button type="button" className="self-start font-semibold text-bad" onClick={() => upload.stop(u.key)}>{t("common.stopUpload")}</button>
                    </>
                  ) : (
                    <span className="font-semibold text-bad">{u.error}</span>
                  )}
                </div>
              </li>
            ))}
            {shown.map((i) => (
              <li key={i.id} className={`overflow-hidden rounded-2xl border bg-card ${i.id === selectedId ? "border-primary ring-2 ring-primary" : "border-border"}`}>
                <button type="button" onClick={() => { setSelectedId(i.id); setName(null); }} className="block w-full text-left">
                  {/* eslint-disable-next-line @next/next/no-img-element -- library image */}
                  <img src={i.url} alt={t("media.imageAlt", { name: i.name })} loading="lazy" className="h-28 w-full object-cover" />
                  <span className="flex flex-col gap-0.5 p-2.5">
                    <strong className="truncate text-xs">{i.name}</strong>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{i.width} × {i.height} · {sizeLabel(i.byteSize)}</span>
                    <span className={`text-[11px] font-semibold ${i.usedIn.length ? "text-good" : "text-muted-foreground"}`}>{usageLabel(t, i)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <aside aria-label={t("media.selected")} className="flex min-w-72 flex-[1_1_300px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card">
        {selected ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- library image */}
            <img src={selected.url} alt={t("media.selectedAlt", { name: selected.name })} className="h-48 w-full rounded-control object-cover" />
            <label className="flex flex-col gap-1 text-xs font-semibold">
              {t("common.name")}
              <input type="text" className={inputClass} value={name ?? selected.name} disabled={!canManage}
                onChange={(e) => setName(e.target.value)} onBlur={rename} />
            </label>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t("media.size")}</dt>
              <dd className="tabular-nums">{selected.width} × {selected.height} · {selected.contentType === "image/png" ? "PNG" : "JPG"} · {sizeLabel(selected.byteSize)}</dd>
              <dt className="text-muted-foreground">{t("media.added")}</dt>
              <dd>{selected.createdByName} · {tf.dateTime(selected.createdAt, workspaceId)}</dd>
              <dt className="text-muted-foreground">{t("media.usedIn")}</dt>
              <dd className="flex flex-col gap-0.5">
                {selected.usedIn.length === 0 && t("common.notUsed")}
                {selected.usedIn.map((u) => (
                  <Link key={u.postId} href={`/posts?view=list&ws=${workspaceId}&post=${u.postId}`} className="font-semibold text-primary underline-offset-2 hover:underline">
                    {usedInLabel(t, u)}
                  </Link>
                ))}
                {selected.templateCount > 0 && <span className="text-muted-foreground">{t("media.templates", { count: selected.templateCount })}</span>}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Link href={`/posts?view=compose&ws=${workspaceId}&image=${selected.id}`} className={secondaryButtonClass}>{t("common.useInNewPost")}</Link>
              {canManage && (
                <button type="button" className={destructiveButtonClass} disabled={!selected.canDelete} onClick={remove}>{t("common.delete")}</button>
              )}
            </div>
            {deleteReason(t, selected) && <p className="text-xs text-muted-foreground">{deleteReason(t, selected)}</p>}
            <ErrorText message={error} />
            <p className="rounded-control bg-muted p-2.5 text-xs text-muted-foreground">
              {t("media.agentNote")}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("media.pickOne")}</p>
        )}
      </aside>
      {brandedOpen && (
        <BrandedImageDialog workspaceId={workspaceId} images={images} selectedId={selectedId} hasLogo={hasLogo}
          onClose={() => setBrandedOpen(false)}
          onSaved={(id) => { setSelectedId(id); router.refresh(); }} />
      )}
    </section>
  );
}
