import { getTranslations } from "next-intl/server";
import { roleHasPermission, type locationsList, type geogridSettingsGet, integrationEnv } from "@opengmb/core";
import { BudgetPanel } from "../../../components/rank-tracking/budget-panel";
import { TrackerSetupForm } from "../../../components/rank-tracking/tracker-setup-form";
import { StaffMessages } from "../../../components/rank-tracking/staff-messages";
import { CompetitorsView } from "../../../components/rank-tracking/competitors-view";
import { KeywordRankView } from "../../../components/rank-tracking/keyword-rank-view";
import { QuickScanView } from "../../../components/rank-tracking/quick-scan-view";
import { TrackersView } from "../../../components/rank-tracking/trackers-view";
import { UsageAndKeyView } from "../../../components/rank-tracking/usage-and-key-view";
import { TabLinks } from "../../../components/page-parts";
import { PageHeader } from "../../../components/ui";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import {
  geogridHref,
  isUuid,
  mapsBrowserKey,
  parseView,
  rankDataIsSample,
  VIEWS,
} from "../../../lib/rank-tracking";
import { geogrid_settings_get, locations_list } from "../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Search = { view?: string; config?: string; run?: string; keyword?: string };

export default async function GeogridPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations("geogrid");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const sp = await searchParams;
  const canManage = roleHasPermission(role, "geogrid:manage");
  const canAdmin = roleHasPermission(role, "google:manage");
  // Budget, markup and spend are agency numbers: client roles never see them (core refuses them too).
  const canCost = roleHasPermission(role, "geogrid:cost");
  const requested = parseView(sp.view);
  const view = (requested === "new" && !canManage) || (requested === "usage" && !canCost) ? "trackers" : requested;
  const missingKeyHint = canAdmin ? t("page.mapMissingAdmin") : t("page.mapMissingOther");
  const tabs = VIEWS.filter((v) => (v.key !== "new" || canManage) && (v.key !== "usage" || canCost));

  const views = (
    <>
      {view === "trackers" && (
        <TrackersView
          configParam={isUuid(sp.config) ? sp.config : undefined}
          runParam={isUuid(sp.run) ? sp.run : undefined}
          canManage={canManage}
          canCost={canCost}
          apiKey={mapsBrowserKey(integrationEnv())}
          missingKeyHint={missingKeyHint}
          sample={rankDataIsSample(integrationEnv())}
        />
      )}
      {view === "keywords" && <KeywordRankView canManage={canManage} sample={rankDataIsSample(integrationEnv())} />}
      {view === "competitors" && (
        <CompetitorsView configParam={isUuid(sp.config) ? sp.config : undefined} keywordParam={sp.keyword} />
      )}
      {view === "scan" && (
        <QuickScanView
          scanParam={isUuid(sp.config) ? sp.config : undefined}
          runParam={isUuid(sp.run) ? sp.run : undefined}
          canManage={canManage}
          apiKey={mapsBrowserKey(integrationEnv())}
          missingKeyHint={missingKeyHint}
          sample={rankDataIsSample(integrationEnv())}
        />
      )}
      {view === "new" && <NewTrackerView canAdmin={canAdmin} sample={rankDataIsSample(integrationEnv())} />}
      {view === "usage" && <UsageAndKeyView canAdmin={canAdmin} />}
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
      />
      <TabLinks
        label={t("page.viewsLabel")}
        items={tabs.map((v) => ({ href: geogridHref({ view: v.key }), label: t(`views.${v.key}`), current: v.key === view }))}
      />
      {/* Everything below that can show budget, markup or charged text sits inside StaffMessages for
          roles with geogrid:cost (the same roles as geogrid:manage); clients never receive those strings. */}
      {canCost ? <StaffMessages>{views}</StaffMessages> : views}
    </div>
  );
}

async function NewTrackerView({ canAdmin, sample }: { canAdmin: boolean; sample: boolean }) {
  const [locRes, setRes] = await Promise.all([locations_list({ status: "active" }), geogrid_settings_get()]);
  const locs = locRes.ok ? (locRes.data as Handler<typeof locationsList>).locations : [];
  const settings = setRes.ok ? (setRes.data as Handler<typeof geogridSettingsGet>) : null;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <TrackerSetupForm
        locations={locs.map((l) => ({ id: l.id, label: l.title ?? l.name }))}
        drivers={(settings?.drivers ?? []).flatMap((d) =>
          d.id === "dataforseo_serp" ? [] : [{ ...d, id: d.id }],
        )}
        sample={sample}
      />
      {settings && <BudgetPanel settings={settings} canEdit={canAdmin} />}
    </div>
  );
}
