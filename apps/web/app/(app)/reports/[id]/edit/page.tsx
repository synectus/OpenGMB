import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import type { reportsDefinitionsList } from "@opengmb/core";
import { roleHasPermission } from "@opengmb/core";
import { ReportEditor } from "../../../../../components/reports/report-editor";
import { PageHeader, linkClass } from "../../../../../components/ui";
import { actorContextFor } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import type { EditorState } from "../../../../../lib/reports";
import { reports_definitions_list } from "../../../../_generated/actions";
import { editorData } from "../../editor-data";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function EditReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("reports");
  const { role } = await actorContextFor(userId);
  if (!roleHasPermission(role, "report:manage")) redirect("/reports");
  const { id } = await params;
  const res = await reports_definitions_list({});
  const def = res.ok ? (res.data as Handler<typeof reportsDefinitionsList>).definitions.find((d) => d.id === id) : undefined;
  if (!def) notFound();
  const initial: EditorState = {
    kind: def.kind,
    workspaceId: def.workspaceId,
    name: def.name,
    scope: def.scope,
    groupId: def.groupId ?? "",
    locationIds: def.locationIds,
    period: def.period,
    customFrom: def.customFrom ?? "",
    customTo: def.customTo ?? "",
    language: def.language,
    comment: def.comment ?? "",
    aiSummary: def.aiSummary,
    agencyName: def.branding.agencyName ?? "",
    colour: def.branding.colour ?? "",
    schedule: def.schedule,
    recipients: def.recipients.join(", "),
  };
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t("breadcrumb")} className="text-sm text-muted-foreground">
        <Link href="/reports" className={linkClass}>{t("title")}</Link> › {def.name}
      </nav>
      <PageHeader title={t("editTitle")} description={t("editorDescription")} />
      <ReportEditor mode="edit" id={def.id} initial={initial} {...(await editorData(def))} />
    </div>
  );
}
