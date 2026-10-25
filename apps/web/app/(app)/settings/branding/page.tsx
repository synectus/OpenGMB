import type { brandingGet, brandingLogos, storageUsage, workspacesList } from "@opengmb/core";
import { emailConfigured, roleHasPermission } from "@opengmb/core";
import { getTranslations } from "next-intl/server";
import { BrandingForm } from "../../../../components/branding-form";
import { SettingsShell } from "../../../../components/settings/settings-shell";
import { ErrorText } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { getOrgDomain } from "../../../../lib/org-domain";
import { branding_get, branding_logos, storage_usage, workspaces_list } from "../../../_generated/actions";

type Got = Awaited<ReturnType<typeof brandingGet.handler>>;
type Logos = Awaited<ReturnType<typeof brandingLogos.handler>>;
type Usage = Awaited<ReturnType<typeof storageUsage.handler>>;
type Workspaces = Awaited<ReturnType<typeof workspacesList.handler>>;

export default async function BrandingPage() {
  const t = await getTranslations("settings");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const canEdit = roleHasPermission(role, "branding:manage");
  const [result, logos, ws, usage, domain] = await Promise.all([
    branding_get({}),
    branding_logos({}),
    workspaces_list({}),
    canEdit ? storage_usage({}) : null,
    getOrgDomain(),
  ]);
  const logoIds = logos.ok ? (logos.data as Logos) : { orgLogoFileId: null, workspaceLogos: [] };
  const logoData = {
    orgFileId: logoIds.orgLogoFileId,
    clients: ws.ok
      ? (ws.data as Workspaces).workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          fileId: logoIds.workspaceLogos.find((l) => l.workspaceId === w.id)?.fileId ?? null,
        }))
      : [],
    usage: usage?.ok ? (usage.data as Usage) : null,
  };
  return (
    <SettingsShell
      current="/settings/branding"
      role={role}
      title={t("branding.title")}
      description={t("branding.description")}
    >
      {result.ok ? (
        <BrandingForm
          initial={(result.data as Got).branding}
          canEdit={canEdit}
          emailOn={emailConfigured()}
          logos={logoData}
          domain={domain}
        />
      ) : (
        <ErrorText message={`${result.error.code}: ${result.error.message}`} />
      )}
    </SettingsShell>
  );
}
