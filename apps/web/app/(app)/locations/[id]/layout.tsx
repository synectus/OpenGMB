import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { locationsList, locationsStats, workspacesList } from "@opengmb/core";
import { ClientMessages } from "../../../../components/client-messages";
import { LocationTabs } from "../../../../components/location-tabs";
import { LocationHeader } from "../../../../components/locations/location-header";
import { ErrorText } from "../../../../components/ui";
import { requireUser } from "../../../../lib/guard";
import { isUuid } from "../../../../lib/locations";
import { locations_list, locations_stats, workspaces_list } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

/** Every page of one location: breadcrumb, title, chips and tab bar. DB reads only (no Google). */
export default async function LocationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [locs, stats, wss] = await Promise.all([
    locations_list({ locationIds: [id] }),
    locations_stats({ locationIds: [id] }),
    workspaces_list(),
  ]);
  if (!locs.ok) {
    return (
      <div className="flex flex-col gap-6">
        <ErrorText message={`${locs.error.code}: ${locs.error.message}`} />
      </div>
    );
  }
  const loc = (locs.data as Handler<typeof locationsList>).locations[0];
  if (!loc) notFound();
  const s = stats.ok ? (stats.data as Handler<typeof locationsStats>).locations[0] : undefined;
  const ws = wss.ok ? (wss.data as Handler<typeof workspacesList>).workspaces.find((w) => w.id === loc.workspaceId) : undefined;

  return (
    <ClientMessages set="locationHub">
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <LocationHeader
          name={loc.name}
          addressSummary={loc.addressSummary}
          workspaceId={loc.workspaceId}
          workspaceName={ws?.name ?? ""}
          status={loc.status}
          needsRelink={loc.needsRelink}
          suspensionOpen={s?.suspensionOpen ?? false}
        />
        <LocationTabs locationId={id} openChanges={s?.openChanges ?? 0} />
      </div>
      {children}
    </div>
    </ClientMessages>
  );
}
