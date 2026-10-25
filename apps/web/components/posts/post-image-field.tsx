"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { postImages_list } from "../../app/_generated/actions";
import { filterImages, sizeLabel, type LibraryImage } from "../../lib/post-images";
import { runCall } from "../post-card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../primitives/dialog";
import { buttonClass, destructiveButtonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { AiPanel, ImageOrigin, StockPanel } from "./image-sources";
import { useImageUpload, type UploadedImage } from "./use-image-upload";

type Tab = "library" | "upload" | "stock" | "ai" | "url";
type Data = { images: LibraryImage[]; can: { manage: boolean } };
const hatch = "bg-muted";

/**
 * The Image section of Compose and the Templates editor. `value` is the image URL the post carries
 * (a library URL or an external https URL). Not rendered for ALERT posts by the caller. Mount it
 * where the old "Image URL (one)" label was; give it the location names for the dialog subtitle.
 * `libraryOnly` (templates): no Image URL tab, and onChange also reports the library image id.
 */
export function PostImageField({
  workspaceId, value, onChange, locationNames = [], maxBytes, disabled = false, libraryOnly = false,
}: {
  workspaceId: string;
  value: string;
  onChange: (url: string, imageId: string | null) => void;
  locationNames?: string[];
  maxBytes: number;
  disabled?: boolean;
  libraryOnly?: boolean;
}) {
  const t = useTranslations("posts");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await runCall<Data>(() => postImages_list({ workspaceId }));
    if ("error" in r) setError(r.error);
    else {
      setData(r.data);
      setError(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    let live = true;
    void runCall<Data>(() => postImages_list({ workspaceId })).then((r) => {
      if (!live) return;
      if ("error" in r) setError(r.error);
      else setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const current = data?.images.find((i) => i.url === value) ?? null;
  const manage = data?.can.manage ?? true;
  const upload = useImageUpload(workspaceId, maxBytes, (img: UploadedImage) => {
    onChange(img.url, img.id);
    void load();
  });
  const active = upload.items.find((i) => i.phase === "uploading");
  const refused = upload.items.find((i) => i.phase === "refused");

  return (
    <fieldset className="flex flex-col gap-2 rounded-panel border border-border p-3.5 text-sm" disabled={disabled}>
      <legend className="px-1.5 text-[13px] font-semibold text-foreground">{t("img.legend")}</legend>
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="img"
          aria-label={value ? t("img.postImage", { name: current?.name ?? value }) : t("img.noImageYet")}
          className={`flex h-24 w-36 items-center justify-center overflow-hidden rounded-control text-center text-xs text-muted-foreground ${hatch} ${value ? "" : "border border-dashed border-input"}`}
        >
          {value && !active ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-chosen image
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : active ? (
            active.name
          ) : (
            t("img.onePerPost")
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {value && !active && (
            <strong className="truncate">{current?.name ?? value}</strong>
          )}
          {value && !active && current && <ImageOrigin image={current} />}
          {active && (
            <div className="flex flex-col gap-1">
              <span className="flex justify-between">
                <strong>{active.name} · {sizeLabel(active.size)}</strong>
                <span className="text-muted-foreground">{active.percent}%</span>
              </span>
              <div role="progressbar" aria-label={t("common.progress")} aria-valuenow={active.percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-1.5 bg-primary" style={{ width: `${active.percent}%` }} />
              </div>
            </div>
          )}
          <p className={refused ? "font-semibold text-bad" : "text-muted-foreground"}>
            {refused?.error ??
              (active
                ? t("img.alsoInLibrary")
                : value
                  ? t("img.replaces")
                  : t("img.optionalHint"))}
          </p>
          <div className="flex flex-wrap gap-2">
            {active ? (
              <button type="button" className={destructiveButtonClass} onClick={() => upload.stop(active.key)}>
                {t("common.stopUpload")}
              </button>
            ) : (
              <>
                <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
                  {t("img.chooseFromLibrary")}
                </button>
                {manage && !libraryOnly && (
                  <label className={`${secondaryButtonClass} cursor-pointer`}>
                    {refused ? t("img.chooseAnother") : t("img.upload")}
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="sr-only"
                      onChange={(e) => {
                        void upload.addFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
                {value && (
                  <button type="button" className={secondaryButtonClass} onClick={() => onChange("", null)}>
                    {t("img.remove")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ErrorText message={error} />
      <ImageDialog
        open={open}
        onOpenChange={setOpen}
        data={data}
        current={current}
        value={value}
        locationNames={locationNames}
        workspaceId={workspaceId}
        maxBytes={maxBytes}
        libraryOnly={libraryOnly}
        onPick={(url, id) => {
          onChange(url, id);
          setOpen(false);
        }}
        onUploaded={load}
      />
    </fieldset>
  );
}

function ImageDialog({
  open, onOpenChange, data, current, value, locationNames, workspaceId, maxBytes, libraryOnly, onPick, onUploaded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: Data | null;
  current: LibraryImage | null;
  value: string;
  locationNames: string[];
  workspaceId: string;
  maxBytes: number;
  libraryOnly: boolean;
  onPick: (url: string, imageId: string | null) => void;
  onUploaded: () => Promise<void>;
}) {
  const t = useTranslations("posts");
  const [tab, setTab] = useState<Tab>("library");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const upload = useImageUpload(workspaceId, maxBytes, (img) => {
    void onUploaded();
    onPick(img.url, img.id);
  });
  const manage = data?.can.manage ?? false;
  const images = filterImages(data?.images ?? [], { show: "all", q, sort: "newest" });
  const tabs: Tab[] = libraryOnly ? ["library", "upload", "stock", "ai"] : ["library", "upload", "stock", "ai", "url"];
  const label: Record<Tab, string> = { library: t("img.tabLibrary"), upload: t("img.tabUpload"), stock: t("img.tabStock"), ai: t("img.tabAi"), url: t("img.tabUrl") };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("img.chooseTitle")}</DialogTitle>
          {locationNames.length > 0 && (
            <DialogDescription>{t("img.forPost", { names: locationNames.join(", ") })}</DialogDescription>
          )}
        </DialogHeader>
        <div role="tablist" aria-label={t("img.imageSource")} className="flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((tb) => (
            <button key={tb} type="button" role="tab" aria-selected={tab === tb} onClick={() => setTab(tb)}
              className={`h-9 shrink-0 whitespace-nowrap px-3 text-sm ${tab === tb ? "border-b-2 border-primary font-bold" : "text-muted-foreground"}`}>
              {label[tb]}
            </button>
          ))}
        </div>

        {tab === "library" && (
          <div className="flex flex-col gap-3">
            <input type="search" aria-label={t("common.searchImages")} placeholder={t("common.searchImages")} className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} />
            {data && data.images.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-control border border-dashed border-input p-6 text-center text-sm">
                <strong>{t("common.noImagesTitle")}</strong>
                <span className="text-muted-foreground">{t("common.noImagesBody")}</span>
                {manage && <button type="button" className={buttonClass} onClick={() => setTab("upload")}>{t("common.chooseFiles")}</button>}
              </div>
            ) : (
              <div role="radiogroup" aria-label={t("img.libraryImages")} className="grid max-h-72 auto-rows-max grid-cols-3 gap-2 overflow-auto sm:grid-cols-4">
                {images.map((i) => (
                  <label key={i.id} className={`flex cursor-pointer flex-col overflow-hidden rounded-control border ${(picked ?? current?.id) === i.id ? "border-2 border-primary" : "border-border"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- library image */}
                    <img src={i.url} alt="" loading="lazy" className="h-20 w-full object-cover" />
                    <span className="flex items-center gap-1 p-1.5 text-xs">
                      <input type="radio" name="pick" checked={(picked ?? current?.id) === i.id} onChange={() => setPicked(i.id)} />
                      <span className="truncate">{i.name}</span>
                    </span>
                    {(i.aiGenerated || i.source === "stock") && <span className="px-1.5 pb-1.5"><ImageOrigin image={i} /></span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "upload" &&
          (manage ? (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-control border-2 border-dashed border-input p-6 text-center text-sm">
              <strong>{t("img.dropOrChoose")}</strong>
              <span className="text-muted-foreground">{t("img.addedAndUsed")}</span>
              <input type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(e) => { void upload.addFiles(e.target.files); e.target.value = ""; }} />
              {upload.items.map((i) => (
                <span key={i.key} className={i.phase === "refused" ? "font-semibold text-bad" : "text-muted-foreground"}>
                  {i.phase === "refused" ? i.error : `${i.name} ${i.percent}%`}
                </span>
              ))}
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">{t("common.needsRole")}</p>
          ))}

        {tab === "stock" &&
          (manage ? (
            <StockPanel workspaceId={workspaceId} onAdded={(img) => { void onUploaded(); onPick(img.url, img.id); }} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("common.needsRole")}</p>
          ))}

        {tab === "ai" &&
          (manage ? (
            <AiPanel workspaceId={workspaceId} onAdded={(img) => { void onUploaded(); onPick(img.url, img.id); }} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("common.needsRole")}</p>
          ))}

        {tab === "url" && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("img.urlLabel")}
            <input type="url" className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            <span className="text-xs font-normal text-muted-foreground">{t("img.urlHint")}</span>
          </label>
        )}

        <DialogFooter>
          {value && tab === "library" && (
            <span className="mr-auto text-xs text-muted-foreground">{t("img.replacesCurrent", { name: current?.name ?? t("img.theOneChosen") })}</span>
          )}
          <button type="button" className={secondaryButtonClass} onClick={() => onOpenChange(false)}>{t("common.cancel")}</button>
          {tab !== "upload" && tab !== "stock" && tab !== "ai" && (
            <button type="button" className={buttonClass}
              disabled={tab === "library" ? !(picked ?? current?.id) : !url.trim()}
              onClick={() => {
                if (tab === "url") return onPick(url.trim(), null);
                const img = data?.images.find((i) => i.id === (picked ?? current?.id));
                if (img) onPick(img.url, img.id);
              }}>
              {t("img.use")}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
