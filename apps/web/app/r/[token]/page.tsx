// apps/web/app/r/[token]/page.tsx
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { viewSharedReport } from "@opengmb/core";
import { DownloadPdf } from "../../../components/share/download-pdf";
import { Denied, ShareFrame } from "../../../components/share/share-frame";
import { getDb } from "../../../lib/auth";
import { makeTimeFormat } from "../../../lib/time-format";
import {
  deniedCopy,
  expiryLine,
  formatSize,
  keywordNote,
  shareKeywordUsers,
  shareSentence,
  shareTiles,
  subline,
} from "../../../lib/share-page";

// Public, no login. Every render audits a view, so never cache or prerender.
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reports");
  return {
    title: t("sharedReport"),
    robots: { index: false, follow: false },
    // The token is in the URL: never send it to the logo's host or anywhere else.
    referrer: "no-referrer",
  };
}

const TONE = { good: "text-good", bad: "text-bad", neutral: "text-foreground", none: "text-muted-foreground" } as const;

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("reports");
  const tPerf = await getTranslations("performance");
  const v = await viewSharedReport(getDb(), token);
  // invalid and not_ready are the only views without a brand ("in" narrows the union member).
  if (!("brand" in v)) notFound();
  if (v.status !== "ok") {
    const c = deniedCopy(v.status, v.brand.agencyName, t);
    return <Denied brand={v.brand} title={c.title} body={c.body} />;
  }
  // Public page: no session, so the report's own workspace settings come with the view.
  const tf = makeTimeFormat({ zones: [{ id: "w", timeZone: v.timeZone, dateFormat: v.dateFormat }], workspaceId: "w" });
  const c = v.content;
  const sentence = c ? shareSentence(c, tf, undefined, tPerf) : null;
  const size = formatSize(v.pdfBytes, t);
  const pdfHref = `/r/${encodeURIComponent(token)}/pdf`;
  const h2 = "font-display text-lg font-bold";
  return (
    <ShareFrame
      brand={v.brand}
      right={c ? <span className="text-muted-foreground">{t("reportFor", { name: c.workspaceName })}</span> : undefined}
      footer={
        <>
          <span className="text-foreground">{expiryLine(v.expiresAt, v.brand.agencyName, tf, undefined, t)}</span>
          <span className="text-sm text-muted-foreground">{t("neverIncludes")}</span>
          <span className="text-xs text-muted-foreground">{t("madeWith")}</span>
        </>
      }
    >
      <section aria-label={t("reportTitle")} className="flex flex-col gap-2.5">
        <h1 className="font-display text-[28px] leading-[34px] font-extrabold">
          {v.title} · {v.periodLabel}
        </h1>
        {c && <p className="text-muted-foreground">{subline(c, tf, undefined, t)}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <DownloadPdf href={pdfHref} />
          {size && <span className="text-sm text-muted-foreground">{size}</span>}
        </div>
      </section>

      {v.summary && (
        <section aria-label={t("summary")} className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted px-4.5 py-4">
          <h2 className={h2}>{t("summary")}</h2>
          <p className="text-foreground">{v.summary}</p>
        </section>
      )}

      {c && (
        <>
          <section aria-label={t("keyFigures")}>
            <h2 className={`${h2} mb-3`}>{t("keyFigures")}</h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {shareTiles(c.kpis, tPerf).map((tile) => (
                <li key={tile.key} className="flex flex-col gap-1 rounded-xl border border-border p-4 shadow-card">
                  <span className="text-sm text-muted-foreground">{tPerf(`kpi_${tile.key}`)}</span>
                  <strong className="font-display text-[26px] leading-8 font-extrabold tabular-nums">{tile.value}</strong>
                  <span className={`text-sm font-semibold ${TONE[tile.delta.tone]}`}>{tile.delta.text}</span>
                </li>
              ))}
            </ul>
          </section>

          {sentence && (
            <section aria-label={t("whatItMeans")}>
              <p className="text-base leading-6 text-foreground">{sentence}</p>
            </section>
          )}

          <section aria-label={t("topKeywords")}>
            <h2 className={`${h2} mb-1`}>{t("topKeywords")}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{keywordNote(c.keywordMonths, t, tPerf)}</p>
            {c.keywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noKeywordPeriod")}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[360px] border-collapse text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th scope="col" className="px-3.5 py-2.5 text-left text-xs font-bold">{t("keyword")}</th>
                      <th scope="col" className="px-3.5 py-2.5 text-right text-xs font-bold">{t("uniqueUsers")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.keywords.map((k) => (
                      <tr key={k.keyword} className="border-t border-border">
                        <th scope="row" className="px-3.5 py-2.5 text-left font-medium">{k.keyword}</th>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{shareKeywordUsers(k, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {c.comment && (
            <section aria-label={t("noteFrom", { agency: v.brand.agencyName })} className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted px-4.5 py-4">
              <h2 className={h2}>{t("noteFrom", { agency: v.brand.agencyName })}</h2>
              <p className="whitespace-pre-line text-foreground">{c.comment}</p>
            </section>
          )}
        </>
      )}
    </ShareFrame>
  );
}
