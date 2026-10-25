import { getTranslations } from "next-intl/server";
import { emailConfigured, isPlatformAdmin, type mcpProposalsList, integrationEnv } from "@opengmb/core";
import { ConnectView } from "../../../components/agents/connect-view";
import { ProposalsView } from "../../../components/agents/proposals-view";
import { ResourcesView } from "../../../components/agents/resources-view";
import { TabLinks } from "../../../components/page-parts";
import { PageHeader } from "../../../components/ui";
import { AGENT_VIEWS, agentsHref, parseProposalFilter, parseView } from "../../../lib/agents";
import { actorContextFor, getDb } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { liveStatus } from "../../../lib/live-status";
import { mcp_proposals_list } from "../../_generated/actions";

type Search = { view?: string; status?: string; proposal?: string };
type Listed = Awaited<ReturnType<typeof mcpProposalsList.handler>>;

const PENDING_CAP = 100;

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const sp = await searchParams;
  const t = await getTranslations("agents");
  const view = parseView(sp.view);

  // The tab count: pending only (the filter runs before the limit since this plan's core fix).
  const pendingRes = await mcp_proposals_list({ status: "pending", limit: PENDING_CAP });
  const pendingCount = pendingRes.ok ? (pendingRes.data as Listed).proposals.length : null;
  const countText = pendingCount ? (pendingCount >= PENDING_CAP ? `${PENDING_CAP}+` : `${pendingCount}`) : null;
  const writesLive =
    liveStatus(integrationEnv(), emailConfigured()).rows.find((r) => r.key === "writes")?.state === "live";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <TabLinks
        label={t("viewsLabel")}
        items={AGENT_VIEWS.map((v) => ({
          href: agentsHref({ view: v.key }),
          label: v.key === "proposals" && countText ? `${t(`views.${v.key}`)} (${countText})` : t(`views.${v.key}`),
          current: v.key === view,
        }))}
      />
      {view === "connect" && (
        <ConnectView
          userId={userId}
          readOnlyOnly={role === "client_viewer"}
          showSettingNames={await isPlatformAdmin(getDb(), userId)}
        />
      )}
      {view === "proposals" && (
        <ProposalsView
          filter={parseProposalFilter(sp.status)}
          selectedId={sp.proposal}
          pendingCount={pendingCount}
          writesLive={writesLive}
        />
      )}
      {view === "resources" && <ResourcesView role={role} />}
    </div>
  );
}
