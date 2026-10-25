import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { suspensionCasesList } from "@opengmb/core";
import { roleHasPermission, SUSPENSION_APPEAL } from "@opengmb/core";
import { SuspensionManager } from "../../../../../components/suspension-manager";
import { actorContextFor } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import { suspension_cases_list } from "../../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LocationSuspensionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await requireUser();
  const t = await getTranslations("locationHub.susp");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { role } = await actorContextFor(userId);
  const r = await suspension_cases_list({ locationId: id });
  const cases = r.ok ? (r.data as Handler<typeof suspensionCasesList>).cases : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h2 className="font-display text-lg font-bold">
            {cases[0] ? t("titleWithName", { name: cases[0].locationName }) : t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("intro")}
          </p>
        </div>
        <a
          href={SUSPENSION_APPEAL.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground"
        >
          {t("form")}
        </a>
      </div>
      {!r.ok ? (
        <p role="alert" className="text-[13px] text-bad">
          <span className="font-mono">{r.error.code}</span>: {r.error.message}
        </p>
      ) : (
        <SuspensionManager
          locationId={id}
          canEdit={roleHasPermission(role, "profile:edit")}
          cases={cases}
        />
      )}
    </div>
  );
}
