// apps/web/app/(app)/reports/editor-data.ts
import "server-only";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, locationsList, performanceKeywords, performanceSummary, workspacesList } from "@opengmb/core";
import { DEFAULT_COLOUR, PERFORMANCE_CONFIG, definitionPeriod, emailConfigured, reportPeriodLabel, reportSummaryOffer } from "@opengmb/core";
import { locationLabel } from "../../../lib/locations";
import { keywordUsers, tileDelta } from "../../../lib/performance";
import { scheduleText } from "../../../lib/reports";
import { getTimeFormat } from "../../../lib/time-format-server";
import { locationGroups_list, locations_list, performance_keywords, performance_summary, workspaces_list } from "../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Shape = { workspaceId: string; scope: string; locationIds: string[]; groupId: string | null; period: "last_month" | "last_30_days" | "custom"; customFrom: string | null; customTo: string | null };

export async function editorData(shape: Shape) {
  const [wsRes, grpRes, locRes] = await Promise.all([workspaces_list(), locationGroups_list({}), locations_list({})]);
  const workspaces = wsRes.ok ? (wsRes.data as Handler<typeof workspacesList>).workspaces : [];
  const groups = grpRes.ok ? (grpRes.data as Handler<typeof locationGroupsList>).groups : [];
  const locations = locRes.ok ? (locRes.data as Handler<typeof locationsList>).locations : [];
  const tf = await getTimeFormat();
  const t = await getTranslations("reports");
  const tPerf = await getTranslations("performance");
  // Money text lives in aiCost, which is never sent to a client viewer's browser: it goes in as a prop.
  const tCost = await getTranslations("aiCost");
  const offer = reportSummaryOffer();
  const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(offer.maxChargeMicroUsd / 1_000_000);
  const summaryNotes = [offer.charged ? tCost("reportSummaryPrice", { price }) : tCost("reportSummaryFree"), ...(offer.aiOn ? [] : [tCost("reportSummaryOff")])];
  const range = definitionPeriod(shape, new Date());
  const group = groups.find((g) => g.id === shape.groupId);
  const target =
    shape.scope === "workspace" ? { workspaceId: shape.workspaceId }
      : shape.scope === "locations" && shape.locationIds.length ? { locationIds: shape.locationIds }
        : group?.locationIds.length ? { locationIds: group.locationIds } : null;
  const [sum, kw] = target
    ? await Promise.all([performance_summary({ ...target, ...range }), performance_keywords({ ...target, months: 3, limit: 3 })])
    : [null, null];
  const kpis = sum?.ok ? (sum.data as Handler<typeof performanceSummary>).kpis : [];
  const keywords = kw?.ok ? (kw.data as Handler<typeof performanceKeywords>).keywords : [];
  const order = ["calls", "websiteClicks", "directions", "impressionsMaps", "impressionsSearch"];
  return {
    workspaces,
    groups: groups.map((g) => ({ id: g.id, workspaceId: g.workspaceId, label: g.name })),
    locations: locations.map((l) => ({ id: l.id, workspaceId: l.workspaceId, label: locationLabel(l) })),
    groupDeleted: shape.scope === "group" && !group,
    emailOn: emailConfigured(),
    summaryNotes,
    defaultColour: DEFAULT_COLOUR,
    scheduleNote: scheduleText(PERFORMANCE_CONFIG.monthlyReportCron, PERFORMANCE_CONFIG.monthlyEmailLinkDays, tf, shape.workspaceId, t),
    preview: {
      periodLabel: reportPeriodLabel(range.from, range.to),
      workspaceName: workspaces.find((w) => w.id === shape.workspaceId)?.name ?? "",
      kpis: order.flatMap((key) => {
        const k = kpis.find((x) => x.key === key);
        return k ? [{ label: tPerf(`kpi_${key}`), value: k.total.toLocaleString("en-US"), delta: tileDelta(k, tPerf).text }] : [];
      }),
      keywords: keywords.map((k) => ({ text: k.keyword, users: keywordUsers(k, tPerf) })),
    },
  };
}
