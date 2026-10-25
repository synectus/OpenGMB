"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { branding_removeLogo } from "../app/_generated/actions";
import { ErrorText, secondaryButtonClass } from "./ui";

/** One logo slot: the agency's (no workspaceId) or one client's. Upload and remove go to core. */
export function LogoUploader({
  label,
  workspaceId,
  fileId,
  canEdit,
}: {
  label: string;
  workspaceId?: string;
  fileId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.brandingForm");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(fileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const form = new FormData();
    form.set("file", file);
    if (workspaceId) form.set("workspaceId", workspaceId);
    try {
      const res = await fetch("/api/files/logo", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; file: { id: string } }
        | { ok: false; error: { message: string } }
        | null;
      if (res.ok && body?.ok) {
        setCurrent(body.file.id);
        setNote(t("logoSaved"));
        router.refresh();
      } else {
        setError(body && !body.ok ? body.error.message : `HTTP ${res.status}`);
      }
    } catch {
      setError(t("uploadFailed"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await branding_removeLogo(workspaceId ? { workspaceId } : {});
    setBusy(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setCurrent(null);
    setNote(t("logoRemoved"));
    router.refresh();
  }

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2 rounded-control border border-border bg-muted p-3">
      <span className="text-sm font-semibold">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- an uploaded logo served by /api/files, not optimised by next/image
          <img src={`/api/files/${current}`} alt="" className="h-10 w-auto max-w-40 rounded-control bg-card object-contain" />
        ) : (
          <span className="text-sm text-muted-foreground">{t("noLogo")}</span>
        )}
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={label}
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => void onPick(e.target.files?.[0])}
            />
            <button type="button" disabled={busy} onClick={() => input.current?.click()} className={secondaryButtonClass}>
              {busy ? t("uploading") : current ? t("replaceFile") : t("chooseFile")}
            </button>
            {current && (
              <button type="button" disabled={busy} onClick={() => void onRemove()} className={secondaryButtonClass}>
                {t("removeFile")}
              </button>
            )}
          </>
        )}
      </div>
      {note && <p role="status" className="text-[13px] font-semibold text-good">{note}</p>}
      <ErrorText message={error} />
    </div>
  );
}
