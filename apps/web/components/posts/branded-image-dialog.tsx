"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { POST_IMAGE_LAYOUTS, POST_IMAGE_TEXT } from "@opengmb/core/post-image-templates";
import { postImages_renderBranded } from "../../app/_generated/actions";
import { formProblem, initialForm, toActionInput, type BrandedForm } from "../../lib/branded-image";
import type { LibraryImage } from "../../lib/post-images";
import { runCall } from "../post-card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../primitives/dialog";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

/** Preview needs the session cookie, so it is a same-origin POST; nothing is stored. */
async function fetchPreview(body: object): Promise<{ blob: Blob } | { error: string }> {
  const res = await fetch("/api/post-images/branded-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { blob: await res.blob() };
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    if (j.error?.code) return { error: `${j.error.code}: ${j.error.message ?? ""}` };
  } catch {
    // fall through
  }
  return { error: `HTTP_${res.status}: ` };
}

export function BrandedImageDialog({
  workspaceId, images, selectedId, hasLogo, onClose, onSaved,
}: {
  workspaceId: string;
  images: LibraryImage[];
  selectedId: string | null;
  hasLogo: boolean;
  onClose: () => void;
  onSaved: (imageId: string) => void;
}) {
  const t = useTranslations("posts");
  const [form, setForm] = useState<BrandedForm>(() => initialForm({ hasLogo }, selectedId ?? images[0]?.id ?? null));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BrandedForm>(k: K, v: BrandedForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Revoke the blob URL when it changes and when the dialog closes.
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  const problem = formProblem(form);
  const layoutLabel = { band: t("branded.layoutBand"), frame: t("branded.layoutFrame") } as const;

  async function preview() {
    if (problem) return setError(t(problem as never));
    setBusy("preview");
    setError(null);
    try {
      const r = await fetchPreview(toActionInput(form, workspaceId));
      if ("error" in r) return setError(r.error);
      setPreviewUrl(URL.createObjectURL(r.blob));
    } catch {
      setError(t("branded.previewFailed"));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (problem) return setError(t(problem as never));
    setBusy("save");
    setError(null);
    const r = await runCall<{ image: { id: string } }>(() => postImages_renderBranded(toActionInput(form, workspaceId)));
    setBusy(null);
    if ("error" in r) return setError(r.error);
    onSaved(r.data.image.id);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("branded.title")}</DialogTitle>
          <DialogDescription>{t("branded.intro")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <form className="flex min-w-0 flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
            <label className="flex flex-col gap-1 text-xs font-semibold">
              {t("branded.photo")}
              <select className={inputClass} value={form.photoImageId ?? ""} onChange={(e) => set("photoImageId", e.target.value || null)}>
                {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs font-semibold">{t("branded.layout")}</legend>
              {POST_IMAGE_LAYOUTS.map((l) => (
                <label key={l} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="branded-layout" checked={form.layout === l} onChange={() => set("layout", l)} />
                  {layoutLabel[l]}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-xs font-semibold">
              {t("branded.headline")}
              <input type="text" className={inputClass} value={form.headline} onChange={(e) => set("headline", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold">
              {t("branded.subline")}
              <input type="text" className={inputClass} value={form.subline} onChange={(e) => set("subline", e.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">
              {t("branded.englishOnly", { headline: POST_IMAGE_TEXT.headlineMax, subline: POST_IMAGE_TEXT.sublineMax })}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.useLogo && hasLogo} disabled={!hasLogo} onChange={(e) => set("useLogo", e.target.checked)} />
              {t("branded.useLogo")}
            </label>
            {!hasLogo && <p className="text-xs text-muted-foreground">{t("branded.noLogoHint")}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={secondaryButtonClass} disabled={busy !== null}>
                {busy === "preview" ? t("branded.previewing") : t("branded.preview")}
              </button>
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={save}>
                {busy === "save" ? t("branded.saving") : t("branded.save")}
              </button>
            </div>
            <ErrorText message={error} />
          </form>
          <div className="flex min-w-0 items-start">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- blob preview
              <img src={previewUrl} alt={t("branded.previewAlt")} className="w-full rounded-control border border-border" />
            ) : (
              <p className="flex aspect-[4/3] w-full items-center justify-center rounded-control border border-dashed border-input bg-muted p-3 text-center text-sm text-muted-foreground">
                {t("branded.previewEmpty")}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
