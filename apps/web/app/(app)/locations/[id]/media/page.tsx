import { notFound } from "next/navigation";
import type { mediaCustomerList, mediaList } from "@opengmb/core";
import { MEDIA_LIMITS, roleHasPermission, integrationEnv } from "@opengmb/core";
import { MediaManager } from "../../../../../components/media-manager";
import { ErrorText } from "../../../../../components/ui";
import { actorContextFor } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import { liveStatus } from "../../../../../lib/live-status";
import { locations_list, media_customer_list, media_list } from "../../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LocationMediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { role } = await actorContextFor(userId);
  const [own, cust] = await Promise.all([
    media_list({ locationId: id }),
    media_customer_list({ locationId: id }),
  ]);
  if (!own.ok && own.error.code === "NOT_FOUND") notFound();
  const data = own.ok ? (own.data as Handler<typeof mediaList>) : null;
  // The same client's other active locations: a photo can go to several at once.
  const sib = data
    ? await locations_list({ workspaceId: data.location.workspaceId, status: "active" })
    : null;
  const siblings = sib?.ok
    ? (sib.data as { locations: { id: string; name: string; addressSummary: string | null; phone: string | null }[] }).locations
        .filter((l) => l.id !== id)
        .map((l) => ({ id: l.id, name: l.name, addressSummary: l.addressSummary, phone: l.phone }))
    : [];
  const p = MEDIA_LIMITS.photo;
  // Writes fail in the worker, not on click, and only in live mode with writes off (factory.ts).
  const writesOff =
    liveStatus(integrationEnv(), false).rows.find((r) => r.key === "writes")?.state === "off";
  const uploadLimits = {
    minBytes: p.minBytes,
    maxBytes: p.maxBytes,
    minShortEdgePx: p.minShortEdgePx,
    minimumsExempt: MEDIA_LIMITS.upload.minimumsExemptCategories,
  };

  return (
    <div className="flex flex-col gap-6">
      {!data ? (
        <ErrorText message={own.ok ? null : `${own.error.code}: ${own.error.message}`} />
      ) : (
        <MediaManager
          locationId={id}
          workspaceId={data.location.workspaceId}
          siblings={siblings}
          canEdit={roleHasPermission(role, "profile:edit")}
          categories={MEDIA_LIMITS.categories.values}
          uploadLimits={uploadLimits}
          writesOff={writesOff}
          items={data.items}
          operations={data.operations}
          customer={cust.ok ? (cust.data as Handler<typeof mediaCustomerList>).items : []}
          customerError={cust.ok ? null : `${cust.error.code}: ${cust.error.message}`}
        />
      )}
    </div>
  );
}
