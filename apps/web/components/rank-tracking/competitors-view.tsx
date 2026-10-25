import { getTranslations } from "next-intl/server";
import type { geogridCompetitorChanges, geogridCompetitorProfiles, geogridConfigsList } from "@opengmb/core";
import { geogrid_competitors_changes, geogrid_competitors_profiles, geogrid_configs_list } from "../../app/_generated/actions";
import { categoryCell, daysSince } from "../../lib/competitor-profile";
import { geogridHref, usd } from "../../lib/rank-tracking";
import { Pill, PillLinks, TableWrap, tdClass, thClass } from "../page-parts";
import { EmptyState, ErrorText } from "../ui";
import { NotLiveNote } from "./badges";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Change = Handler<typeof geogridCompetitorChanges>["keywords"][number]["competitors"][number];
type Profile = Handler<typeof geogridCompetitorProfiles>["profiles"][number];
type Tr = Awaited<ReturnType<typeof getTranslations>>;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function RankChange({ c, t }: { c: Change; t: Tr }) {
  if (c.status === "new") return <Pill tone="info">{t("competitorChanges.isNew")}</Pill>;
  if (c.status === "dropped") return <Pill tone="warn">{t("competitorChanges.dropped")}</Pill>;
  if (c.rankChange === null) return <span className="text-muted-foreground">{t("competitorChanges.none")}</span>;
  if (c.rankChange === 0) return <span className="text-muted-foreground">{t("competitorChanges.same")}</span>;
  const up = c.rankChange > 0;
  return (
    <Pill tone={up ? "good" : "bad"}>
      {t(up ? "competitorChanges.up" : "competitorChanges.down", { value: Math.abs(c.rankChange) })}
    </Pill>
  );
}

function CategoriesCell({ p, t }: { p: Profile | undefined; t: Tr }) {
  if (!p) return <span className="text-muted-foreground">{t("competitorChanges.noProfile")}</span>;
  const { shown, more } = categoryCell(p.primaryCategory, p.additionalCategories);
  const added = p.change?.categoriesAdded ?? [];
  const removed = p.change?.categoriesRemoved ?? [];
  return (
    <>
      <span className="block">
        {shown.join(", ")}
        {more > 0 && <span className="text-muted-foreground"> {t("competitorChanges.moreCategories", { count: more })}</span>}
      </span>
      {added.length > 0 && <span className="block text-xs text-good">{t("competitorChanges.catAdded", { names: added.join(", ") })}</span>}
      {removed.length > 0 && <span className="block text-xs text-warn">{t("competitorChanges.catRemoved", { names: removed.join(", ") })}</span>}
    </>
  );
}

function LastPostCell({ p, t, now }: { p: Profile | undefined; t: Tr; now: Date }) {
  if (!p) return <span className="text-muted-foreground">-</span>;
  const days = daysSince(p.lastPostAt, now);
  if (days === null) return <span className="text-muted-foreground">{t("competitorChanges.noPosts")}</span>;
  return (
    <>
      <span className="block">{days === 0 ? t("competitorChanges.postToday") : t("competitorChanges.postDays", { days })}</span>
      {p.recentPostsCount !== null && <span className="block text-xs text-muted-foreground">{t("competitorChanges.recentPosts", { count: p.recentPostsCount })}</span>}
      {p.change?.postedSince && <span className="block text-xs text-good">{t("competitorChanges.newPost")}</span>}
    </>
  );
}

/** The Competitors tab: per tracker and keyword, the competitors from the latest finished scan and what changed since the one before. */
export async function CompetitorsView({
  configParam,
  keywordParam,
}: {
  configParam: string | undefined;
  keywordParam: string | undefined;
}) {
  const t = await getTranslations("geogrid");
  const cfgRes = await geogrid_configs_list();
  if (!cfgRes.ok) return <ErrorText message={`${cfgRes.error.code}: ${cfgRes.error.message}`} />;
  const configs = (cfgRes.data as Handler<typeof geogridConfigsList>).configs;
  if (configs.length === 0) {
    return <EmptyState title={t("competitorChanges.empty")}>{t("competitorChanges.emptyHint")}</EmptyState>;
  }
  const selected = configs.find((c) => c.id === configParam) ?? configs[0]!;
  const res = await geogrid_competitors_changes({ configId: selected.id });
  if (!res.ok) return <ErrorText message={`${res.error.code}: ${res.error.message}`} />;
  const { keywords } = res.data as Handler<typeof geogridCompetitorChanges>;
  const profRes = await geogrid_competitors_profiles({ configId: selected.id });
  const prof = profRes.ok ? (profRes.data as Handler<typeof geogridCompetitorProfiles>) : null;
  const profiles = new Map((prof?.profiles ?? []).map((p) => [p.placeId, p]));
  const now = new Date();
  const current = keywords.find((k) => k.keyword === keywordParam) ?? keywords[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("competitorChanges.description")}</p>
      {configs.length > 1 && (
        <PillLinks
          label={t("competitorChanges.tracker")}
          items={configs.map((c) => ({
            href: geogridHref({ view: "competitors", config: c.id }),
            label: c.targetName,
            current: c.id === selected.id,
          }))}
        />
      )}
      {!current ? (
        <EmptyState title={t("competitorChanges.empty")}>{t("competitorChanges.emptyHint")}</EmptyState>
      ) : (
        <>
          {keywords.length > 1 && (
            <PillLinks
              label={t("competitorChanges.keyword")}
              items={keywords.map((k) => ({
                href: geogridHref({ view: "competitors", config: selected.id, keyword: k.keyword }),
                label: k.keyword,
                current: k.keyword === current.keyword,
              }))}
            />
          )}
          {current.dataSource !== "live" && <NotLiveNote>{t("keywords.sampleNote")}</NotLiveNote>}
          <p className="text-xs text-muted-foreground">
            {current.previousDate
              ? t("competitorChanges.compare", { current: current.currentDate, previous: current.previousDate })
              : t("competitorChanges.firstDay")}
          </p>
          {prof && (
            <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <p>
                {prof.refresh.schedule === "manual"
                  ? t("competitorChanges.profilesOff")
                  : prof.refresh.refreshedAt
                    ? t("competitorChanges.profilesRefreshed", { date: prof.refresh.refreshedAt.slice(0, 10), schedule: t(`schedule.${prof.refresh.schedule}`) })
                    : t("competitorChanges.profilesNone")}
              </p>
              {prof.dataSource && prof.dataSource !== "live" && profiles.size > 0 && <p>{t("competitorChanges.profilesSample")}</p>}
              {prof.refresh.skippedNoPlaceId > 0 && <p>{t("competitorChanges.profilesSkipped", { count: prof.refresh.skippedNoPlaceId })}</p>}
              {prof.refresh.estimatedRefreshUsd !== null && prof.refresh.schedule !== "manual" && (
                <p>{t("competitorChanges.profilesCost", { amount: usd(prof.refresh.estimatedRefreshUsd) })}</p>
              )}
            </div>
          )}
          <TableWrap>
            <table className="w-full text-left text-sm">
              <caption className="px-3 py-2 text-left font-display font-bold text-foreground">
                {t("competitorChanges.heading")}: {current.keyword}
              </caption>
              <thead className="border-b border-border bg-muted">
                <tr>
                  {(["colBusiness", "colRating", "colSeen", "colAvg", "colMove", "colReviews", "colRatingChange", "colCategories", "colPhotos", "colLastPost"] as const).map((h) => (
                    <th key={h} scope="col" className={thClass}>
                      {t(`competitorChanges.${h}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {current.competitors.slice(0, 25).map((c) => (
                  <tr key={c.placeId}>
                    <td className={`${tdClass} font-semibold`}>
                      {c.title}
                      {c.status === "dropped" && (
                        <span className="block text-xs font-normal text-muted-foreground">{t("competitorChanges.droppedNote")}</span>
                      )}
                    </td>
                    <td className={`${tdClass} tabular-nums`}>
                      {c.rating === null ? "-" : c.rating.toFixed(1)}
                      {c.reviewCount !== null && <span className="text-muted-foreground"> ({c.reviewCount})</span>}
                    </td>
                    <td className={`${tdClass} tabular-nums`}>{c.appearances}</td>
                    <td className={`${tdClass} tabular-nums`}>{c.averageRank.toFixed(1)}</td>
                    <td className={tdClass}>
                      <RankChange c={c} t={t} />
                    </td>
                    <td className={`${tdClass} tabular-nums`}>{c.reviewsAdded === null ? "-" : signed(c.reviewsAdded)}</td>
                    <td className={`${tdClass} tabular-nums`}>{c.ratingChange === null ? "-" : signed(c.ratingChange)}</td>
                    <td className={tdClass}>
                      <CategoriesCell p={profiles.get(c.placeId)} t={t} />
                    </td>
                    <td className={`${tdClass} tabular-nums`}>
                      {profiles.get(c.placeId)?.totalPhotos ?? "-"}
                      {profiles.get(c.placeId)?.change?.photosAdded ? (
                        <span className="block text-xs text-muted-foreground">{signed(profiles.get(c.placeId)!.change!.photosAdded!)}</span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <LastPostCell p={profiles.get(c.placeId)} t={t} now={now} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
