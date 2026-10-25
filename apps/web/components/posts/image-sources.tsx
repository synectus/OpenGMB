"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  postImages_addStock, postImages_generate, postImages_searchStock, postImages_sources,
} from "../../app/_generated/actions";
import { runCall } from "../post-card";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

export type SourceImage = { id: string; url: string };
type Sources = {
  stock: { available: boolean };
  ai: { available: boolean; chargeMicroUsd: number; charged: boolean };
};
type Stock = { id: string; thumbUrl: string; alt: string; creditName: string; creditUrl: string };

/** micro-USD as dollars, at least 2 and at most 3 decimals (an image costs a few cents). */
export const priceLabel = (micro: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micro / 1_000_000);

function useSources(workspaceId: string) {
  const [s, setS] = useState<Sources | null>(null);
  useEffect(() => {
    let live = true;
    void runCall<Sources>(() => postImages_sources({ workspaceId })).then((r) => {
      if (live && "data" in r) setS(r.data);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return s;
}

/** Free stock photo search. Saving one stores the photographer's credit with it. */
export function StockPanel({ workspaceId, onAdded }: { workspaceId: string; onAdded: (img: SourceImage) => void }) {
  const t = useTranslations("posts");
  const sources = useSources(workspaceId);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Stock[] | null>(null);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(p: number) {
    setBusy("search");
    setError(null);
    const r = await runCall<{ results: Stock[]; hasMore: boolean }>(() => postImages_searchStock({ workspaceId, query: q, page: p }));
    setBusy(null);
    if ("error" in r) return setError(r.error);
    setPage(p);
    setMore(r.data.hasMore);
    setResults((cur) => (p === 1 ? r.data.results : [...(cur ?? []), ...r.data.results]));
  }
  async function add(id: string) {
    setBusy(id);
    setError(null);
    const r = await runCall<{ image: SourceImage }>(() => postImages_addStock({ workspaceId, stockPhoto: id }));
    setBusy(null);
    if ("error" in r) return setError(r.error);
    onAdded(r.data.image);
  }

  if (sources && !sources.stock.available) return <p className="text-sm text-muted-foreground">{t("img.stockNotSetUp")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void search(1); }}>
        <input type="search" aria-label={t("img.stockSearchLabel")} placeholder={t("img.stockSearchLabel")} className={inputClass} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className={buttonClass} disabled={!q.trim() || busy !== null}>{t("img.stockSearch")}</button>
      </form>
      <p className="text-xs text-muted-foreground">
        {t("img.stockFree")} <a href="https://pixabay.com/" target="_blank" rel="noreferrer" className="underline">{t("img.stockFrom")}</a>
      </p>
      <ErrorText message={error} />
      {results && results.length === 0 && <p className="text-sm text-muted-foreground">{t("img.stockNone")}</p>}
      {results && results.length > 0 && (
        <ul className="grid max-h-96 auto-rows-max grid-cols-2 gap-2 overflow-auto sm:grid-cols-3">
          {results.map((p) => (
            <li key={p.id} className="flex flex-col overflow-hidden rounded-control border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element -- provider thumbnail */}
              <img src={p.thumbUrl} alt={p.alt} loading="lazy" className="aspect-[4/3] w-full object-cover" />
              <span className="flex flex-col gap-1 p-1.5 text-xs">
                <a href={p.creditUrl} target="_blank" rel="noreferrer" className="truncate underline">{t("img.stockCredit", { name: p.creditName })}</a>
                <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void add(p.id)}>
                  {busy === p.id ? t("img.working") : t("img.stockUse")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void search(page + 1)}>{t("img.stockMore")}</button>}
    </div>
  );
}

/** AI image: the price is shown before the button, and the result is labelled AI-made. */
export function AiPanel({ workspaceId, onAdded }: { workspaceId: string; onAdded: (img: SourceImage) => void }) {
  const t = useTranslations("posts");
  const sources = useSources(workspaceId);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    const r = await runCall<{ image: SourceImage }>(() => postImages_generate({ workspaceId, subject }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    onAdded(r.data.image);
  }

  if (sources && !sources.ai.available) return <p className="text-sm text-muted-foreground">{t("img.aiNotSetUp")}</p>;
  const price = sources ? priceLabel(sources.ai.chargeMicroUsd) : "";
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("img.aiSubjectLabel")}
        <textarea className={inputClass} rows={3} maxLength={500} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">{t("img.aiGuardNote")}</p>
      {sources && (
        <p className="text-sm font-semibold">{sources.ai.charged ? t("img.aiCost", { price }) : t("img.aiNoCharge")}</p>
      )}
      <ErrorText message={error} />
      <div>
        <button type="button" className={buttonClass} disabled={busy || subject.trim().length < 3 || !sources} onClick={() => void make()}>
          {busy ? t("img.working") : sources?.ai.charged ? t("img.aiMakeWithPrice", { price }) : t("img.aiMake")}
        </button>
      </div>
    </div>
  );
}

/** One line under an image: the photographer credit or the AI label. Null for plain uploads. */
export function ImageOrigin({ image }: { image: { source: string; creditName: string | null; creditUrl: string | null; aiGenerated: boolean } }) {
  const t = useTranslations("posts");
  if (image.aiGenerated) return <span className="text-xs text-muted-foreground">{t("img.aiLabel")}</span>;
  if (image.source === "stock" && image.creditName && image.creditUrl) {
    return <a href={image.creditUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">{t("img.stockCredit", { name: image.creditName })}</a>;
  }
  return null;
}
