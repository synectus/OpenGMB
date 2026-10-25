import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { profileCategoriesSuggestions } from "@opengmb/core";
import { profile_categories_suggestions } from "../../app/_generated/actions";
import { geogridHref } from "../../lib/rank-tracking";
import { EmptyState, ErrorText, linkClass } from "../ui";
import { CategorySuggestions } from "./category-suggestions";
import { h2Class, hintClass, sectionClass } from "./section";

type Out = Awaited<ReturnType<(typeof profileCategoriesSuggestions)["handler"]>>;

/** K3: categories the ranking competitors use and this location lacks. Reads stored competitor profiles; Add records a change set for approval. */
export async function CategorySuggestionsPanel({ locationId, workspaceId, canEdit }: { locationId: string; workspaceId: string; canEdit: boolean }) {
  const t = await getTranslations("profile");
  const r = await profile_categories_suggestions({ locationId });
  const data = r.ok ? (r.data as Out) : null;
  return (
    <section aria-label={t("suggest.title")} className={sectionClass}>
      <h2 className={h2Class}>{t("suggest.title")}</h2>
      <p className={hintClass}>{t("suggest.intro")}</p>
      {!r.ok || !data ? (
        <ErrorText message={r.ok ? t("suggest.loadError") : `${r.error.code}: ${r.error.message}`} />
      ) : data.status === "no_competitor_data" ? (
        <EmptyState
          title={t("suggest.refreshFirst")}
          action={<Link href={geogridHref({ view: "competitors" })} className={linkClass}>{t("suggest.openCompetitors")}</Link>}
        >
          {t("suggest.refreshFirstHint")}
        </EmptyState>
      ) : (
        <>
          {data.dataSource !== "live" && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center rounded-full border border-warn-border bg-warn-bg px-2.5 py-0.5 text-xs font-bold text-warn">
                {t("suggest.notLive")}
              </span>
              <span>{t("suggest.sample")}</span>
            </p>
          )}
          {data.suggestions.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">{t("suggest.noGaps", { count: data.competitorCount })}</p>
          ) : (
            <CategorySuggestions
              locationId={locationId}
              workspaceId={workspaceId}
              suggestions={data.suggestions}
              total={data.competitorCount}
              display={data.display}
              canEdit={canEdit}
            />
          )}
        </>
      )}
    </section>
  );
}
