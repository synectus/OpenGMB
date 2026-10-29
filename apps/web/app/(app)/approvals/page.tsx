import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { approvalsQueue, workspacesList } from "@opengmb/core";
import { ApprovalDetail } from "../../../components/approvals/approval-detail";
import { ApprovalKeys } from "../../../components/approvals/approval-keys";
import { ApprovalList } from "../../../components/approvals/approval-list";
import { AutoApproveChip } from "../../../components/auto-approve-chip";
import { PillLinks, TabLinks } from "../../../components/page-parts";
import { EmptyState, ErrorText, PageHeader } from "../../../components/ui";
import {
  TABS,
  adjacentKey,
  afterActionKey,
  approvalsHref,
  inLocation,
  inTab,
  itemKey,
  locationOptions,
  parseItemKey,
  parseTab,
} from "../../../lib/approvals";
import { approvalSurfaces } from "../../../lib/approval-surfaces";
import { actorContextFor } from "../../../lib/auth";
import { redirectClientHome } from "../../../lib/client-home";
import { requireUser } from "../../../lib/guard";
import { autoApproveIds } from "../../../lib/scope";
import { narrowArgs } from "../../../lib/scope-pages";
import { currentScope } from "../../../lib/scope-server";
import { approvals_queue, workspaces_list } from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

type Search = { tab?: string; item?: string; ws?: string; loc?: string };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { userId } = await requireUser();
  // Layouts do not re-run on every client navigation, so each page checks too.
  const { home } = await actorContextFor(userId);
  redirectClientHome(home);

  const t = await getTranslations("approvals");
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const scope = await currentScope(sp.ws);
  const ws = scope.workspaceId ?? undefined;
  const carry = scope.urlWs; // a ?ws= deep link survives tab and item links

  const [queueRes, wsRes] = await Promise.all([
    approvals_queue({ workspaceId: ws, ...narrowArgs(scope) }),
    workspaces_list(),
  ]);
  if (!queueRes.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("title")} />
        <ErrorText message={`${queueRes.error.code}: ${queueRes.error.message}`} />
      </div>
    );
  }
  const { items: all, counts, truncated } = queueRes.data as Handler<typeof approvalsQueue>;
  const workspaces = wsRes.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces : [];

  const surfaces = approvalSurfaces(counts);
  const ofTab = inTab(all, tab);
  const locations = locationOptions(ofTab);
  const locOption = locations.find((o) => o.id === sp.loc);
  const loc = locOption?.id;
  const items = inLocation(ofTab, loc);
  const wanted = parseItemKey(sp.item);
  const selected =
    (wanted && items.find((i) => i.type === wanted.type && i.id === wanted.id)) || items[0] || null;
  const keys = items.map(itemKey);
  const selectedKey = selected ? itemKey(selected) : null;
  const hrefFor = (key: string | null) => (key ? approvalsHref({ tab, ws: carry, loc, item: key }) : null);
  const prevHref = hrefFor(adjacentKey(keys, selectedKey, -1));
  const nextHref = hrefFor(adjacentKey(keys, selectedKey, 1));
  const redirectTo = approvalsHref({ tab, ws: carry, loc, item: afterActionKey(keys, selectedKey) });
  const now = new Date().getTime(); // not Date.now(): react-hooks/purity rejects it in a component

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<AutoApproveChip workspaceIds={autoApproveIds(scope, workspaces)} />}
      />
      <TabLinks
        label={t("filterType")}
        items={TABS.map((tb) => ({
          href: approvalsHref({ tab: tb.key, ws: carry, loc }),
          label: (
            <>
              {t(`tab.${tb.key}`)}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {surfaces.tabs[tb.key]}
              </span>
            </>
          ),
          current: tb.key === tab,
        }))}
      />
      {workspaces.length > 1 && (
        <PillLinks
          label={t("filterClient")}
          items={[
            { href: approvalsHref({ tab, ws: "all" }), label: t("allClients"), current: scope.kind === "all" },
            ...workspaces.map((w) => ({
              href: approvalsHref({ tab, ws: w.id }),
              label: w.name,
              current: scope.kind !== "all" && scope.workspaceId === w.id,
            })),
          ]}
        />
      )}
      {locations.length > 1 && (
        <PillLinks
          label={t("filterLocation")}
          items={[
            { href: approvalsHref({ tab, ws: carry }), label: t("allLocations"), current: !loc },
            ...locations.map((o) => ({
              href: approvalsHref({ tab, ws: carry, loc: o.id }),
              label: o.label,
              current: loc === o.id,
            })),
          ]}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {t.rich("queueNote", {
          link: (chunks) => (
            <Link href="/reviews?view=queue&qstatus=blocked" className="underline">
              {chunks}
            </Link>
          ),
        })}
        {locOption ? ` ${t("showingInLocation", { shown: items.length, total: ofTab.length, location: locOption.label })}` : ""}{truncated ? ` ${t("showingOldest", { shown: all.length, total: counts.total })}` : ""}
      </p>

      {items.length === 0 ? (
        tab === "all" ? (
          <EmptyNext id="approvals" />
        ) : (
          <EmptyState title={t("emptyTabTitle")}>{t("emptyTabBody")}</EmptyState>
        )
      ) : (
        <>
          <div className="flex flex-col overflow-hidden rounded-panel border border-border bg-card shadow-card lg:flex-row">
            <ApprovalList items={items} selectedKey={selectedKey} tab={tab} ws={carry} loc={loc} now={now} />
            <section aria-label={t("selectedItem")} className="min-w-0 flex-1 p-5 lg:p-6">
              {selected && <ApprovalDetail key={selectedKey} item={selected} redirectTo={redirectTo} />}
            </section>
          </div>
          <ApprovalKeys prevHref={prevHref} nextHref={nextHref} />
        </>
      )}
    </div>
  );
}
