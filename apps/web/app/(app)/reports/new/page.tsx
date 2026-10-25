import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { roleHasPermission } from "@opengmb/core";
import { ReportEditor } from "../../../../components/reports/report-editor";
import { PageHeader } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import type { EditorState } from "../../../../lib/reports";
import { reportStart } from "../../../../lib/scope-pages";
import { currentScope } from "../../../../lib/scope-server";
import { editorData } from "../editor-data";

export default async function NewReportPage({ searchParams }: { searchParams: Promise<{ type?: string; ws?: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("reports");
  const { role } = await actorContextFor(userId);
  if (!roleHasPermission(role, "report:manage")) redirect("/reports");
  const sp = await searchParams;
  if (sp.type && sp.type !== "performance" && sp.type !== "reviews") notFound();
  const first = await editorData({ workspaceId: "", scope: "workspace", locationIds: [], groupId: null, period: "last_month", customFrom: null, customTo: null });
  const scope = await currentScope(sp.ws);
  const start = reportStart(scope, first.workspaces.map((w) => w.id));
  const { workspaceId } = start;
  const data = await editorData({ workspaceId, scope: "workspace", locationIds: [], groupId: null, period: "last_month", customFrom: null, customTo: null });
  const initial: EditorState = {
    kind: sp.type === "reviews" ? "reviews" : "performance",
    workspaceId, name: "", scope: start.scope, groupId: start.groupId, locationIds: start.locationIds, period: "last_month",
    customFrom: "", customTo: "", language: "en", comment: "", aiSummary: false, agencyName: "", colour: "",
    schedule: "none", recipients: "",
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("newTitle")} description={t("editorDescription")} />
      <ReportEditor mode="new" initial={initial} {...data} />
    </div>
  );
}
