import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { profileChangesList } from "@opengmb/core";
import { roleHasPermission, integrationEnv } from "@opengmb/core";
import { ProfileChanges } from "../../../../../components/profile-changes";
import { actorContextFor } from "../../../../../lib/auth";
import { parseStatus, statusPills } from "../../../../../lib/changes";
import { requireUser } from "../../../../../lib/guard";
import { liveStatus } from "../../../../../lib/live-status";
import { pushFacts } from "../../../../../lib/push-facts";
import { profile_changes_list } from "../../../../_generated/actions";
import { EmptyNext } from "../../../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Listed = Handler<typeof profileChangesList>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 200;

export default async function LocationChangesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { userId } = await requireUser();
  const t = await getTranslations("locationHub.changes");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const status = parseStatus((await searchParams).status);
  const { role } = await actorContextFor(userId);
  const canEdit = roleHasPermission(role, "profile:edit");
  const live = liveStatus(integrationEnv(), false, await pushFacts()).rows;
  const writesOff = live.find((r) => r.key === "writes")?.state === "off";
  const pubsubLive = live.find((r) => r.key === "pubsub")?.state === "live";

  const [r, openR] = await Promise.all([
    profile_changes_list({ locationId: id, ...(status === "all" ? {} : { status }), limit: LIMIT }),
    status === "open" ? null : profile_changes_list({ locationId: id, status: "open", limit: LIMIT }),
  ]);
  const changes = r.ok ? (r.data as Listed).changes : [];
  const openCount = status === "open" ? changes.length : openR?.ok ? (openR.data as Listed).changes.length : 0;
  const name = changes[0]?.locationName;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-bold">{name ? t("titleWithName", { name }) : t("title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("intro")}
        </p>
      </div>
      <nav aria-label={t("filterAria")} className="flex flex-wrap gap-2">
        {statusPills(openCount).map((p) => (
          <Link
            key={p.key}
            href={p.key === "open" ? `/locations/${id}/changes` : `/locations/${id}/changes?status=${p.key}`}
            aria-current={p.key === status ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              p.key === status ? "border-brand/40 bg-brand-tint font-bold" : "border-input bg-card font-medium"
            }`}
          >
            {p.key === "open" ? t("pill.open", { count: openCount }) : t(`pill.${p.key}`)}
          </Link>
        ))}
      </nav>
      {!canEdit && <p className="text-sm text-muted-foreground">{t("askOwner")}</p>}
      {!r.ok ? (
        <p role="alert" className="text-[13px] text-bad">
          <span className="font-mono">{r.error.code}</span>: {r.error.message}
        </p>
      ) : changes.length === 0 ? (
        status === "open" || status === "all" ? (
          <EmptyNext id="changes" href={`/locations/${id}/health`} />
        ) : (
          <div className="flex flex-col items-center gap-1 rounded-panel border border-dashed border-input bg-card px-6 py-10 text-center">
            <strong className="font-display">{t(`none.${status}`)}</strong>
          </div>
        )
      ) : (
        <ProfileChanges changes={changes} writesOff={writesOff} pubsubLive={pubsubLive} />
      )}
    </div>
  );
}
