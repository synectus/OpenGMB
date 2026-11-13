import { getTranslations } from "next-intl/server";
import { roleHasPermission, type locationsList, type seoKeywordsGet, type workspacesList } from "@opengmb/core";
import { KeywordResearchForm } from "../../../../components/seo/keyword-research-form";
import { KeywordResults } from "../../../../components/seo/keyword-results";
import { ResearchHistory } from "../../../../components/seo/research-history";
import { SeoStaffMessages } from "../../../../components/seo/staff-messages";
import { EmptyState, ErrorText, PageHeader } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { currentScope } from "../../../../lib/scope-server";
import { cityFromAddress, countryFromAddress } from "../../../../lib/seo-keywords";
import { locations_list, seo_keywords_get, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Search = { ws?: string; location?: string; run?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);

export default async function SeoKeywordsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations("seoKeywords");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const sp = await searchParams;
  const canManage = roleHasPermission(role, "geogrid:manage");
  // Prices and charged amounts are agency numbers: client roles never see them (core refuses them too).
  const canCost = roleHasPermission(role, "geogrid:cost");

  const wsRes = await workspaces_list({});
  const workspaces = wsRes.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces.map((w) => ({ id: w.id, name: w.name })) : [];

  // A location link prefills the country and the city text from its address and picks its workspace.
  const locationId = uuid(sp.location);
  let prefill: { workspaceId?: string; country: ReturnType<typeof countryFromAddress>; city: string } = { country: "US", city: "" };
  if (locationId) {
    const locRes = await locations_list({ status: "active" });
    const loc = locRes.ok ? (locRes.data as Handler<typeof locationsList>).locations.find((l) => l.id === locationId) : undefined;
    if (loc) prefill = { workspaceId: loc.workspaceId, country: countryFromAddress(loc.addressSummary), city: cityFromAddress(loc.addressSummary) ?? "" };
  }

  const runId = uuid(sp.run);
  const runRes = runId ? await seo_keywords_get({ runId }) : null;
  const open = runRes?.ok ? (runRes.data as Handler<typeof seoKeywordsGet>) : null;

  const scope = await currentScope(sp.ws);
  const requestedWs = prefill.workspaceId ?? scope.workspaceId ?? undefined;
  const workspaceId = open?.run?.workspaceId ?? (workspaces.find((w) => w.id === requestedWs) ?? workspaces[0])?.id;
  if (!workspaceId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title={t("page.title")} description={t("page.description")} />
        <EmptyState title={t("page.emptyHistory")} />
      </div>
    );
  }

  const histRes = await seo_keywords_get({ workspaceId });
  const history = histRes.ok ? (histRes.data as Handler<typeof seoKeywordsGet>).history : [];

  let charged: Record<string, string> | undefined;
  if (canCost) {
    const tc = await getTranslations("seoKeywordsCost");
    charged = Object.fromEntries(
      history.filter((h) => h.status === "done" && h.chargedUsd !== null).map((h) => [h.id, tc("history.charged", { price: `$${(h.chargedUsd ?? 0).toFixed(2)}` })]),
    );
  }

  const body = (
    <>
      {canManage ? (
        <KeywordResearchForm
          workspaces={workspaces}
          workspaceId={workspaceId}
          defaultCountry={prefill.country}
          defaultCityQuery={prefill.city}
          locationId={locationId}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("page.viewOnly")}</p>
      )}
      {runRes && !runRes.ok && <ErrorText message={`${runRes.error.code}: ${runRes.error.message}`} />}
      {open?.run && (
        <KeywordResults
          run={{ seed: open.run.seed, countryIso: open.run.countryIso, city: open.run.city, status: open.run.status, dataSource: open.run.dataSource, localVolumeNote: open.run.localVolumeNote }}
          rows={open.rows}
        />
      )}
      <ResearchHistory runs={history} workspaceId={workspaceId} charged={charged} />
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("page.title")} description={t("page.description")} />
      {canCost ? <SeoStaffMessages>{body}</SeoStaffMessages> : body}
    </div>
  );
}
