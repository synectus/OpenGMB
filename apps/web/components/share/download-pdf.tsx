"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { primaryLinkButtonClass } from "../page-parts";

export function DownloadPdf({ href }: { href: string }) {
  const t = useTranslations("reports");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(href, { cache: "no-store" });
      if (!r.ok) {
        setError(`HTTP_${r.status}: ${r.status === 410 ? t("dlExpired") : t("dlFailed")}`);
        return;
      }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "report.pdf";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(`NETWORK: ${t("dlNetwork")}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {busy ? (
        <button type="button" disabled aria-busy="true" className={`${primaryLinkButtonClass} opacity-70`}>
          {t("preparingPdf")}
        </button>
      ) : (
        <a href={href} onClick={download} className={primaryLinkButtonClass}>
          {t("downloadPdf")}
        </a>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </div>
  );
}
