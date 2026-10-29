import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationsList, replyTemplatesList, reviewsListUnreplied, workspaceSettingsGet, workspacesList } from "@opengmb/core";
import { ChooseClient } from "../choose-client";
import { EmptyState, ErrorText, secondaryButtonClass } from "../ui";
import { filterFieldClass, linkButtonClass } from "../page-parts";
import { BULK_PAGE, RATING_OPTIONS, bulkRow, ratingsFromParam } from "../../lib/bulk-reply";
import { locationLabel } from "../../lib/locations";
import { getTimeFormat } from "../../lib/time-format-server";
import {
  locations_list, replyTemplates_list, reviews_list_unreplied, workspaceSettings_get, workspaces_list,
} from "../../app/_generated/actions";
import { BulkReply } from "./bulk-reply";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export async function BulkReplyView({
  sp,
  workspaceId,
  scopeLocationIds,
  narrow,
  urlWs,
}: {
  sp: { loc?: string; rating?: string };
  /** The scope's workspace (or the org's only one); null asks for a client. */
  workspaceId: string | null;
  /** Active locations in the scope. */
  scopeLocationIds: string[];
  /** A group or location scope: without a Location pick, the scope's own locations are the filter. */
  narrow: boolean;
  /** A ?ws= deep link, kept through the GET form. */
  urlWs?: string;
}) {
  const t = await getTranslations("reviewsTools");
  const wsRes = await workspaces_list();
  if (!wsRes.ok) return <ErrorText message={`${wsRes.error.code}: ${wsRes.error.message}`} />;
  const workspaces = (wsRes.data as Handler<typeof workspacesList>).workspaces;
  if (workspaces.length === 0) {
    return (
      <EmptyState title={t("bulk.noClientsTitle")} action={<Link href="/workspaces" className={linkButtonClass}>{t("bulk.clientsBtn")}</Link>}>
        {t("bulk.noClientsBody")}
      </EmptyState>
    );
  }
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    return (
      <ChooseClient
        title={t("bulk.pickClientTitle")}
        text={t("bulk.pickClientText")}
        path="/reviews?view=bulk"
        workspaces={workspaces}
      />
    );
  }
  const [locRes, tplRes, setRes] = await Promise.all([
    locations_list({ status: "active" }),
    replyTemplates_list({ workspaceId: ws.id }),
    workspaceSettings_get({ workspaceId: ws.id }),
  ]);
  const locations = locRes.ok
    ? (locRes.data as Handler<typeof locationsList>).locations.filter((l) => l.workspaceId === ws.id && scopeLocationIds.includes(l.id))
    : [];
  const loc = locations.find((l) => l.id === sp.loc)?.id;
  const genericOnly = setRes.ok && (setRes.data as Handler<typeof workspaceSettingsGet>).genericTemplatesOnly;
  const templates = tplRes.ok
    ? (tplRes.data as Handler<typeof replyTemplatesList>).templates.map((x) => ({
        id: x.id,
        name: x.generic ? t("bulk.templateGeneric", { name: x.name }) : x.name,
        allowed: !genericOnly || x.generic,
      }))
    : [];
  const ratings = ratingsFromParam(sp.rating);
  const locationIds = loc ? [loc] : narrow ? locations.map((l) => l.id) : undefined;
  const tf = await getTimeFormat(urlWs);
  const res = await reviews_list_unreplied({
    workspaceId: ws.id,
    locationIds,
    ratings,
    includeSkipped: true,
    limit: BULK_PAGE,
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[860px] text-sm text-foreground">
        {t("bulk.intro")}
      </p>
      <form method="get" aria-label={t("bulk.formAria")} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value="bulk" />
        {urlWs && <input type="hidden" name="ws" value={urlWs} />}
        <select name="loc" aria-label={t("bulk.locationAria")} defaultValue={loc ?? ""} className={filterFieldClass}>
          <option value="">{t("bulk.allLocations", { count: locations.length })}</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{locationLabel(l)}</option>
          ))}
        </select>
        <select name="rating" aria-label={t("bulk.ratingAria")} defaultValue={sp.rating ?? ""} className={filterFieldClass}>
          {RATING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.label)}</option>
          ))}
        </select>
        <button type="submit" className={secondaryButtonClass}>{t("bulk.filter")}</button>
      </form>
      {!res.ok ? (
        <ErrorText message={`${res.error.code}: ${res.error.message}`} />
      ) : (
        <BulkReply
          key={`${ws.id}|${loc ?? ""}|${sp.rating ?? ""}`}
          workspaceId={ws.id}
          workspaceName={ws.name}
          templates={templates}
          filters={{ locationIds, ratings }}
          initialRows={(res.data as Handler<typeof reviewsListUnreplied>).items.map((i) => bulkRow(i, tf, ws.id, t))}
          initialCursor={(res.data as Handler<typeof reviewsListUnreplied>).nextCursor}
        />
      )}
    </div>
  );
}
