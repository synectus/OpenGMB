"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { rankings_setFavorite, rankings_untrack } from "../../app/_generated/actions";
import { positionChange, positionText, shortDay } from "../../lib/keyword-rank";
import { TableWrap, tdClass, thClass } from "../page-parts";
import { ErrorText } from "../ui";
import { SampleBadge } from "./badges";
import { Star } from "./tracker-list";

export type Reading = {
  date: string;
  localPackRank: number | null;
  organicRank: number | null;
  organicUrl: string | null;
  dataSource: "fixture" | "sandbox" | "live";
};
export type KeywordRow = {
  keyword: string;
  favorite: boolean;
  latest: Reading | null;
  previous: Reading | null;
  history: Reading[];
};

const TONE = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const;
const fail = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

function Change({ latest, previous }: { latest: Reading | null; previous: Reading | null }) {
  const t = useTranslations("geogrid");
  if (!latest) return null;
  const items = [
    positionChange(latest.localPackRank, previous?.localPackRank ?? null, previous !== null, t),
    positionChange(latest.organicRank, previous?.organicRank ?? null, previous !== null, t),
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((c, i) =>
        c ? (
          <span key={i} className={`text-xs font-semibold ${TONE[c.tone]}`}>
            {c.label}
          </span>
        ) : null,
      )}
    </div>
  );
}

export function KeywordRankTable({ configId, rows, canManage }: { configId: string; rows: KeywordRow[]; canManage: boolean }) {
  const t = useTranslations("geogrid");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function star(keyword: string, favorite: boolean) {
    setError(null);
    const r = await rankings_setFavorite({ configId, keyword, favorite });
    if (!r.ok) return setError(fail(r));
    router.refresh();
  }
  async function remove(keyword: string) {
    if (!window.confirm(t("keywords.confirmRemove"))) return;
    setError(null);
    const r = await rankings_untrack({ configId, keyword });
    if (!r.ok) return setError(fail(r));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <ErrorText message={error} />
      <TableWrap>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted">
            <tr>
              <th scope="col" className={thClass}>{t("keywords.colKeyword")}</th>
              <th scope="col" className={`${thClass} text-right`}>{t("keywords.colLocalPack")}</th>
              <th scope="col" className={`${thClass} text-right`}>{t("keywords.colOrganic")}</th>
              <th scope="col" className={thClass}>{t("keywords.colChange")}</th>
              <th scope="col" className={thClass}>{t("keywords.colChecked")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((k) => (
              <tr key={k.keyword}>
                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canManage ? (
                      <button
                        type="button"
                        aria-label={t(k.favorite ? "trackers.unfavorite" : "trackers.favorite", { keyword: k.keyword })}
                        onClick={() => star(k.keyword, !k.favorite)}
                        className="inline-flex size-6 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Star filled={k.favorite} />
                      </button>
                    ) : k.favorite ? (
                      <>
                        <Star filled />
                        <span className="sr-only">{t("trackers.favoriteMark")}</span>
                      </>
                    ) : null}
                    <span className="font-semibold text-foreground">{k.keyword}</span>
                    {canManage && (
                      <button
                        type="button"
                        aria-label={t("keywords.remove", { keyword: k.keyword })}
                        onClick={() => remove(k.keyword)}
                        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      >
                        {t("trackers.delete")}
                      </button>
                    )}
                  </div>
                  {k.history.length > 1 && (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{t("keywords.history")}</summary>
                      <ol className="mt-1 flex flex-col gap-0.5">
                        {[...k.history].reverse().map((h) => (
                          <li key={h.date} className="tabular-nums">
                            {shortDay(h.date)}: {positionText(h.localPackRank, t)} / {positionText(h.organicRank, t)}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </td>
                <td className={`${tdClass} text-right font-semibold tabular-nums`}>
                  {k.latest ? positionText(k.latest.localPackRank, t) : <span className="font-normal text-muted-foreground">{t("keywords.notChecked")}</span>}
                </td>
                <td className={`${tdClass} text-right font-semibold tabular-nums`}>
                  {k.latest ? positionText(k.latest.organicRank, t) : null}
                </td>
                <td className={tdClass}>
                  <Change latest={k.latest} previous={k.previous} />
                </td>
                <td className={tdClass}>
                  {k.latest && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="tabular-nums">{shortDay(k.latest.date)}</span>
                      {k.latest.dataSource !== "live" && <SampleBadge />}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
